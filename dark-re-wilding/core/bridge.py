#!/usr/bin/env python3
"""J1 — all-windows faceted scatter bridge for dark_re_wilding.

Standalone (no GUI): loads the raw L1 CSV (~2388 day×ecological-window rows),
serves them to the browser over WebSocket, and relays browser hover → SC as
/dark_nav so every window is AUDIBLE via the sound engine (sc/).

This answers Alice's N1: the FINE points (every ecological window), coloured by
month, faceted by diel phase — not the mean-collapsed monthly scatter.

Data flow:
  L1 CSV ── load+normalize ──▶ WS init(rows) ──▶ browser faceted scatter
  browser hover {idx} ── WS ──▶ bridge ── /dark_nav ──▶ SC :57120 (bed+drone morph)

Keeps the C5 §5.0 hardening: HTTP/WS auto-pick, .viz_ports.json contract,
per-launch cache-bust token, no-cache HTTP, parent-death watch.
Run via viz/dark_re_wilding_viz.command, or:  <venv>/bin/python bridge.py
"""
from __future__ import annotations
import asyncio
import bisect
import csv
import json
import statistics
import math
import os
import socket
import sys
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

_INSTALL = ("  Install into a Python that also has pandas/pyarrow:\n"
            "      pip install websockets python-osc\n"
            "  (or use the repo .darkson.venv)\n")
try:
    import websockets
except ImportError:
    sys.exit("error: websockets not installed.\n" + _INSTALL)
try:
    from pythonosc.udp_client import SimpleUDPClient
except ImportError:
    sys.exit("error: python-osc not installed.\n" + _INSTALL)

ROOT = Path(__file__).resolve().parent          # viz/
DESIGN = ROOT.parent                            # dark_re_wilding/
CSV_PATH = DESIGN / "data" / "wildnings_air_L1.csv"
WEB_CONTROL = DESIGN / ".AIhelper" / "web_control.json"   # GUI 'web' controller port (§B2.21)


_WC_PROBE = {"key": None, "ok": False, "t": 0.0}


def _web_ws_alive(host: str, port: int) -> bool:
    """True iff a live WebSocket server answers on the advertised control port.

    web_control.json can be a leftover from a darkui session that died without
    cleanup; forwarding its dead port would send the page into an endless WS
    reconnect loop. A real (0.3 s-capped) WS handshake tells live from stale —
    and stays silent GUI-side, where a bare TCP poke would make the
    WebController log a handshake-failure traceback on every probe. Falls back
    to a plain TCP connect on websockets builds without the sync client.
    Cached ~2 s per (host, port): callers poll several times a second.
    """
    key = (host, port)
    now = time.monotonic()
    if _WC_PROBE["key"] == key and now - _WC_PROBE["t"] < 2.0:
        return _WC_PROBE["ok"]
    try:
        from websockets.sync.client import connect as _ws_connect
        try:
            with _ws_connect(f"ws://{host}:{port}", open_timeout=0.3,
                             close_timeout=0.3):
                ok = True
        except Exception:
            ok = False
    except ImportError:
        try:
            with socket.create_connection((host, port), timeout=0.3):
                ok = True
        except OSError:
            ok = False
    _WC_PROBE.update(key=key, ok=ok, t=now)
    return ok


def read_web_control():
    """GUI WebController discovery file -> {"web_ws": port} or None (§B2.21).
    Lets the page's DarkWebControl connect when darkui runs the 'web' controller."""
    try:
        d = json.loads(WEB_CONTROL.read_text(encoding="utf-8"))
        if not (isinstance(d, dict) and d.get("web_ws")):
            return None
        # Stale-file guard: a darkui session that died uncleanly leaves this
        # file behind; only forward a port something actually listens on.
        if not _web_ws_alive(str(d.get("host") or "127.0.0.1"), int(d["web_ws"])):
            return None
        return d
    except (OSError, ValueError, TypeError):
        return None

# =========================================================================
# DESIGN CONFIG
# =========================================================================
# SC sound engine (sc/) listens for /dark_nav on this port (langPort).
SC_HOST = "127.0.0.1"
SC_PORT = int(os.environ.get("SC_PORT_OVERRIDE", 57120))

# CSV column -> the plot-axis key the browser uses. All min-max normalised 0..1
# (shared across facets so the 4 diel panels are comparable).
# BIRDNET RICHNESS IS `n_species_analysed` (2026-09-29, dev/precompute/birdnet_nsp_fix.py): species
# per minute over the minutes BirdNET ANALYSED. `n_species_mean` counted every minute of the 1,572
# hour files BirdNET could not decode as a minute with no species; it stays in the CSV, untouched,
# and nothing here reads it any more. Where BirdNET analysed no minute (40 windows) the value is
# UNKNOWN: None on the wire, never 0.0 - a "0 species" there was the very lie the fix removes.
NSP_COL = "n_species_analysed"
BN_COL = "birdnet_minutes"
# THE INDEX PICKER'S LIST (roses + linear), in the pickers' order. AEI and BI joined on 2026-09-30
# (Miguel's design, lab/DECISIONS.md 2026-09-30): two of the biplot's seven measures the pickers
# lacked, so Alice's Q1b "AEI fell in both" can be seen on a rose. AEI is drawn AS MEASURED - higher =
# more uneven, never flipped - and the pages gloss both wherever they name them (legend.js GLOSS).
# The picker only changes the picture: nothing here reaches the engine. The scatter's readings are
# NOT this list (gen_embeddings.py AX_SHORT keeps its six, and the biplot has its own seven).
AX_COLS = {
    "ACI":       "ACI_mean",
    "AEI":       "AEI_mean",
    "BI":        "BI_mean",
    "Ht":        "Ht_mean",
    "n_species": NSP_COL,
    "Anthro":    "AnthroEnergy_mean",
    "Bio":       "BioEnergy_mean",
    "NBPEAKS":   "NBPEAKS_mean",
}
# CSV column -> SC driver name (~cookL1 keys, all 0..1). balance is derived.
DRV_COLS = {
    "aci":          "ACI_mean",
    "bioenergy":    "BioEnergy_mean",
    "anthroenergy": "AnthroEnergy_mean",
    "nbpeaks":      "NBPEAKS_mean",
    "bright":       "Ht_mean",
}
NDSI_COL = "NDSI_mean"          # -> 'balance' driver, mapped (x+1)/2
SPECIES_COL = "top_species_k0_common"
DIEL_ORDER = ["dawn", "day", "dusk", "night"]

# =========================================================================
# Port policy (C5 §5.0). HTTP/WS auto-picked; no OSC-in (J1 is browser-driven).
# =========================================================================
WS_PORT_DEFAULT = 8765
HTTP_PORT_DEFAULT = 8000
PORT_SPAN = 100


def _find_free_port(start: int, span: int = PORT_SPAN) -> int:
    for p in range(start, start + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError(f"No free port in [{start}, {start+span}).")


def _start_parent_death_watch() -> None:
    """Self-terminate when the launching shell dies (SIGKILL/force-quit)."""
    original_parent = os.getppid()
    if original_parent <= 1:
        return

    def _watch():
        while True:
            try:
                cur = os.getppid()
            except OSError:
                return
            if cur != original_parent or cur <= 1:
                os._exit(0)
            time.sleep(2.0)

    threading.Thread(target=_watch, daemon=True, name="parent-watch").start()


def _arg(flag: str):
    """Read `--flag VALUE` from argv (house convention, matches sibling bridges)."""
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


_http_pin = int(_arg("--http") or os.environ.get("HTTP_PORT_OVERRIDE") or 0)
_ws_pin = int(_arg("--ws") or os.environ.get("WS_PORT_OVERRIDE") or 0)
try:
    HTTP_PORT = _http_pin or _find_free_port(HTTP_PORT_DEFAULT)
    WS_PORT = _ws_pin or _find_free_port(WS_PORT_DEFAULT)
except RuntimeError as _e:
    sys.exit(f"error: {_e}")

_SESSION_TOKEN = int(time.time_ns())
_VIZ_URL = (f"http://127.0.0.1:{HTTP_PORT}/index.html"
            f"?ws={WS_PORT}&_sid={_SESSION_TOKEN}")

clients: set = set()
main_loop: asyncio.AbstractEventLoop | None = None
rows: list = []
roses: list = []
l0months: list = []       # J4 biplot: engine's L0 months (pca_0/pca_1 + clusters)
loadings: dict = {}       # J4 biplot: engine PCA loadings (from gen_pca_loadings.py)
spectral: list = []       # spectrogram: per-month freq-band x hour LDFC matrices
spectral_meta: dict = {}  # {bands_hz, hours, synthetic}
mfcc: list = []           # cepstral fingerprint: per-month coeff x hour matrices (REAL)
mfcc_meta: dict = {}      # {n_coeffs, hours, labels, ranges, synthetic}
embeddings: dict = {}     # scatter month-readings: per-(month,diel) PCA/UMAP/SOM (shared space)
sc_client: SimpleUDPClient | None = None
_MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------------------
# load + normalise the L1 windows
# ---------------------------------------------------------------------------
def _to_float(v):
    try:
        f = float(v)
        return f if f == f else None      # drop NaN
    except (TypeError, ValueError):
        return None


def load_rows(channel="air"):
    csv_path = DESIGN / "data" / f"wildnings_{channel}_L1.csv"
    if not csv_path.exists():
        print(f"  [load:{channel}] {csv_path.name} not found."); return []
    with open(csv_path, newline="") as fh:
        raw = list(csv.DictReader(fh))
    needed = set(AX_COLS.values()) | set(DRV_COLS.values()) | {NDSI_COL}
    # per-column robust min/max (1st..99th pct) for stable axes despite outliers
    stats = {}
    for col in needed:
        vals = sorted(v for v in (_to_float(r.get(col)) for r in raw) if v is not None)
        if not vals:
            stats[col] = (0.0, 1.0); continue
        lo = vals[int(0.01 * (len(vals) - 1))]
        hi = vals[int(0.99 * (len(vals) - 1))]
        stats[col] = (lo, hi if hi > lo else lo + 1e-9)

    def norm(col, v):
        if v is None:
            return None
        lo, hi = stats[col]
        return max(0.0, min(1.0, (v - lo) / (hi - lo)))

    out = []
    # THE RAW COLUMN, KEPT FOR RANKING ONLY. `norm` above clamps to the 1st-99th percentile,
    # so on 2388 windows about 24 sit at exactly 0.0 and 24 at exactly 1.0 for every
    # percentile-normalised driver. The legend used to sort those (value, key) pairs,
    # which broke a 25-WAY TIE ALPHABETICALLY BY DATE STRING - so the legend's "hold for the
    # most X window" played the alphabetically last member of the tie, not the record-holder.
    # Measured 2026-09-24: the Anthro chip played a window at raw 24.25 when the record is
    # 113.8, and five of the seven rows were wrong the same way, while the bridge's own
    # docstring promised "the superlatives, without inventing anything". Ranking has to see
    # the unclamped number. This never reaches the browser - init_payload names its keys.
    raw_series = {f: [] for f in RW_FEATURES}
    for i, r in enumerate(raw):
        win = (r.get("ecological_window") or "").strip().lower()
        if win not in DIEL_ORDER:
            continue
        ax = {k: norm(c, _to_float(r.get(c))) for k, c in AX_COLS.items()}
        drv = {k: norm(c, _to_float(r.get(c))) for k, c in DRV_COLS.items()}
        ndsi = _to_float(r.get(NDSI_COL))
        drv["balance"] = None if ndsi is None else max(0.0, min(1.0, (ndsi + 1.0) / 2.0))
        nsp = _to_float(r.get(NSP_COL))            # None = BirdNET analysed no minute of it
        _rk = f"{int(_to_float(r.get('year')) or 0)}|{int(_to_float(r.get('month')) or 0)}|" \
              f"{int(_to_float(r.get('day')) or 0)}|{win}"
        for _f, _c in DRV_COLS.items():
            _v = _to_float(r.get(_c))
            if _v is not None:
                raw_series[_f].append((_v, _rk))
        if ndsi is not None:                       # NDSI is [-1,1] and never clamped, but rank
            raw_series["balance"].append((ndsi, _rk))   # it on the raw value for consistency
        if nsp is not None:                        # an unknown richness is not ranked (it is not 0)
            raw_series["nsp"].append((nsp, _rk))
        out.append({
            "idx": len(out),
            "y": int(_to_float(r.get("year")) or 0),
            "m": int(_to_float(r.get("month")) or 0),
            "d": int(_to_float(r.get("day")) or 0),
            "win": win,
            # recorded minutes behind this window (L1 n_minutes): what the roses' calendar fades by
            # (TASKS P33), like spectro/mfcc's DAY cells - under 30 min faded, 5 or fewer fainter
            "nmin": int(_to_float(r.get("n_minutes")) or 0),
            "nsp": None if nsp is None else round(nsp, 2),
            # the minutes BirdNET analysed: what the roses weight the n_species vertex by
            "bnm": int(_to_float(r.get(BN_COL)) or 0),
            "sp": (r.get(SPECIES_COL) or "").strip() or None,
            "ax": ax,
            "drv": {k: (0.0 if v is None else round(v, 4)) for k, v in drv.items()},
            "_corpus": _corpus_focal(r.get),    # focal top-bird clip; popped before WS (build_channel)
        })
    for _f in raw_series:
        raw_series[_f].sort(key=lambda t: t[0])    # on the RAW value; ties keep input order
    _RW_RAW_SERIES[("L1", channel)] = raw_series
    _RW_LEVEL_STATS.pop("L1", None)                # a rebuild must not serve a stale ranking
    counts = {w: sum(1 for r in out if r["win"] == w) for w in DIEL_ORDER}
    print(f"  [load] {len(out)} L1 windows  "
          + "  ".join(f"{w}:{counts[w]}" for w in DIEL_ORDER))
    return out


def build_roses(win_rows):
    """Aggregate windows -> per-month diel roses (J3). Each month = the mean of
    each index per ecological window (the 4 rose vertices) + the mean SC drivers
    (for hover-sound) + per-day ax values (for the faint variability overlay)."""
    from collections import defaultdict
    groups = defaultdict(list)
    for r in win_rows:
        groups[(r["y"], r["m"])].append(r)
    ax_keys = list(AX_COLS.keys())
    drv_keys = list(DRV_COLS.keys()) + ["balance"]

    def mean(vals):
        vals = [v for v in vals if v is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    def wmean(pairs):
        # n_species: weighted by the minutes BirdNET analysed, the one aggregate of that column
        # (birdnet_nsp_fix.py) - a window with 10 analysed minutes must not count as much as one
        # with 300; a window with none has no value and no weight
        pairs = [(v, w) for v, w in pairs if v is not None and w and w > 0]
        den = sum(w for _, w in pairs)
        return round(sum(v * w for v, w in pairs) / den, 4) if den > 0 else None

    out = []
    for (yr, mo), rs in sorted(groups.items()):
        win = {}
        for w in DIEL_ORDER:
            wr = [r for r in rs if r["win"] == w]
            win[w] = None if not wr else {
                "ax": {k: (wmean([(r["ax"][k], r.get("bnm", 0)) for r in wr]) if k == "n_species"
                           else mean([r["ax"][k] for r in wr])) for k in ax_keys},
                "drv": {k: mean([r["drv"][k] for r in wr]) for k in drv_keys},
                "n": len(wr),
            }
        byday = defaultdict(dict)
        bymin = defaultdict(dict)                  # day -> {window: recorded minutes}
        for r in rs:
            byday[r["d"]][r["win"]] = r["ax"]
            bymin[r["d"]][r["win"]] = r.get("nmin", 0)
        days = [{"d": d, **{w: byday[d].get(w) for w in DIEL_ORDER}, "nm": bymin[d]}
                for d in sorted(byday)]
        out.append({"key": f"{yr}-{mo:02d}", "year": yr, "month": mo,
                    "ndays": len(days), "win": win, "days": days})
    print(f"  [roses] {len(out)} month roses "
          f"({min(r['year'] for r in out)}-{max(r['year'] for r in out)})")
    return out


def compute_returners(l0months):
    """Per month, the 'returner' = the most phenologically-surprising species: one
    that reappears after a calendar-month absence (migrant return), weighted by
    rarity (globally uncommon) x confidence. conf>=0.5 gating happens upstream
    (avoids BirdNET false positives, cf. Alice). A species never seen before is
    flagged kind='first' (verify by ear) and only wins when no real return exists.
    Sets m['returner'] = {common, conf, ndet, gap(months|None), kind} or None."""
    order = sorted(l0months, key=lambda m: (m["year"], m["month"]))
    total = {}
    for m in order:
        for (common, _c, _n) in m.get("_species", []):
            total[common] = total.get(common, 0) + 1
    last = {}                                   # species -> (year, month) last seen
    for m in order:
        best = None
        for (common, conf, ndet) in m.get("_species", []):
            rarity = 1.0 / total.get(common, 1)
            prev = last.get(common)
            if prev is None:
                score, gap, kind = 0.5 * conf * rarity, None, "first"
            else:
                gap = (m["year"] - prev[0]) * 12 + (m["month"] - prev[1])
                if gap < 2:                     # seen recently -> resident, not surprising
                    continue
                score, kind = min(gap, 18) * conf * rarity, "return"
            cand = {"common": common, "conf": round(conf, 2), "ndet": int(ndet),
                    "gap": gap, "kind": kind, "_score": score}
            if best is None or cand["_score"] > best["_score"]:
                best = cand
        for (common, _c, _n) in m.get("_species", []):
            last[common] = (m["year"], m["month"])
        m["returner"] = {k: v for k, v in best.items() if k != "_score"} if best else None


def load_l0(channel="air"):
    """J4 biplot L0 months. AIR = the ENGINE's darkdata/darkdf_l0.parquet for the months, their
    drivers and their BirdNET species (-> returner, corpus), with the BirdNET-dependent ordination
    taken from data/l0.json (below). WATER = the project-side reproduction data/water_l0.json (no
    BirdNET/returner).

    THE AIR ORDINATION IS THE ENGINE'S RECIPE RE-FITTED ON THE CORRECTED COLUMN (2026-09-29).
    The parquet was built by the GUI from n_species_mean, which counted every minute BirdNET could
    not decode as zero species, and it can only be rebuilt in darkui (Run All + Save). Its `nsp`
    was also the engine's MinMax-NORMALISED richness (0..1), not species per minute, so the dot
    size and the hover were never species. viz/gen_l0.py air month re-fits the engine's own recipe
    (read off the .darkproj; it reproduces the parquet exactly on the original column) on
    n_species_analysed and writes data/l0.json; its pca_0/1, kmeans, dbscan, anomaly, nsp and feats
    replace the parquet's here. Everything else stays the parquet's, and ALL 34 months stay: the
    returner and the corpus (both navigation OSC) are month properties that do not depend on the
    richness value, and dropping a month would change them. A month BirdNET never analysed
    (2023-08) arrives with pca_0 = pca_1 = null and nsp = null: kept, not placed."""
    if channel != "air":
        p = DESIGN / "data" / f"{channel}_l0.json"
        if not p.exists():
            print(f"  [l0:{channel}] {p.name} not found; biplot disabled"); return []
        try:
            out = json.loads(p.read_text())
        except (OSError, ValueError) as e:
            print(f"  [l0:{channel}] failed: {e}"); return []
        print(f"  [l0:{channel}] {len(out)} months (biplot, project-side; no BirdNET/returner)")
        return out
    try:
        import pandas as pd
    except ImportError:
        print("  [l0] pandas unavailable; biplot disabled"); return []
    pq = DESIGN / "darkdata" / "darkdf_l0.parquet"
    if not pq.exists():
        print(f"  [l0] {pq.name} not found; biplot disabled"); return []
    df = pd.read_parquet(pq)
    CUR = {"ACI": "ACI_mean", "AEI": "AEI_mean", "BI": "BI_mean", "Bio": "BioEnergy_mean",
           "Anthro": "AnthroEnergy_mean", "NBPEAKS": "NBPEAKS_mean", "n_species": "n_species_mean"}
    DRV = {"aci": "ACI_mean", "bioenergy": "BioEnergy_mean", "anthroenergy": "AnthroEnergy_mean",
           "nbpeaks": "NBPEAKS_mean", "bright": "Ht_mean"}

    def scaler(col):
        if col not in df.columns:
            return lambda v: None
        s = df[col].astype(float); lo, hi = s.quantile(0.01), s.quantile(0.99)
        rng = (hi - lo) or 1e-9
        return lambda v: None if pd.isna(v) else max(0.0, min(1.0, (float(v) - lo) / rng))

    cur_sc = {k: scaler(c) for k, c in CUR.items()}
    drv_sc = {k: scaler(c) for k, c in DRV.items()}
    out = []
    for i, (_, r) in enumerate(df.iterrows()):
        try:
            mm, yy = str(r["_id"]).split("_")[:2]; month, year = int(mm), int(yy)
        except (ValueError, KeyError):
            month, year = 0, 0
        ndsi = r.get("NDSI_mean")
        drv = {k: (drv_sc[k](r.get(DRV[k])) or 0.0) for k in DRV}
        drv["balance"] = 0.0 if (ndsi is None or pd.isna(ndsi)) else max(0.0, min(1.0, (float(ndsi) + 1) / 2))
        # conf-gated top-K species -> feeds the returner (phenological surprise)
        species = []
        for k in range(20):
            common = r.get(f"top_species_k{k}_common")
            conf = r.get(f"top_species_k{k}_conf_mean")
            ndet = r.get(f"top_species_k{k}_n_det")
            if isinstance(common, str) and common.strip() and conf is not None \
                    and not pd.isna(conf) and float(conf) >= 0.5:
                species.append((common.strip(), float(conf),
                                float(ndet) if (ndet is not None and not pd.isna(ndet)) else 0.0))
        out.append({
            "idx": i, "key": f"{year}-{month:02d}", "label": f"{_MON[month]} {year}" if month else str(r.get("_id")),
            "year": year, "month": month,
            "pca_0": float(r["pca_0"]), "pca_1": float(r["pca_1"]),
            "kmeans": int(r.get("kmeans_cluster", -1)), "dbscan": int(r.get("dbscan_cluster", -1)),
            "anomaly": int(r.get("anomaly_label", 1)) == -1,
            "nsp": round(float(r.get("n_species_mean") or 0), 2),
            "feats": {k: (round(cur_sc[k](r.get(CUR[k])), 3) if cur_sc[k](r.get(CUR[k])) is not None else None) for k in CUR},
            "drv": {k: round(v, 4) for k, v in drv.items()},
            "_species": species,
            "_corpus": _corpus_focal(r.get),    # focal top-bird clip; popped before WS
            "_spfiles": _species_files(r.get),  # common->file, for the returner clip; popped below
        })
    # the BirdNET-dependent ordination, from the corrected re-fit (see the docstring)
    refit_p = DESIGN / "data" / "l0.json"
    try:
        refit = {p["key"]: p for p in json.loads(refit_p.read_text())}
    except (OSError, ValueError) as e:
        refit = {}
        print(f"  [l0] {refit_p.name} unavailable ({e}) - the biplot shows the ENGINE's ordination, "
              f"built on the uncorrected n_species_mean; run viz/gen_l0.py air month")
    if refit:
        miss = 0
        for m in out:
            r = refit.get(m["key"])
            if r is None:
                miss += 1
                continue
            for k in ("pca_0", "pca_1", "kmeans", "dbscan", "anomaly", "nsp", "feats"):
                m[k] = r.get(k)
        unplaced = [m["key"] for m in out if m.get("pca_0") is None]
        print(f"  [l0] ordination + n_species from {refit_p.name} (engine recipe on n_species_analysed)"
              + (f"; {miss} month(s) missing from it" if miss else "")
              + (f"; not placed (no BirdNET minute): {', '.join(unplaced)}" if unplaced else ""))
    compute_returners(out)                       # sets m["returner"] from m["_species"]
    # resolve each month's RETURNER clip from its own species→file map (the returner
    # is one of the conf-gated species, so its clip is in the corpus). _ret_clip is
    # internal — popped before the WS payload so no path reaches the browser.
    for m in out:
        ret = m.get("returner")
        m["_ret_clip"] = (m.get("_spfiles") or {}).get(ret["common"]) if ret else None
        m.pop("_spfiles", None)
    # NB: _species is kept on each month here so build_channel can harvest it for
    # the /dark_arp chorus; build_channel pops it before the WS payload is built.
    n_ret = sum(1 for m in out if m.get("returner"))
    print(f"  [l0] {len(out)} months (biplot); {n_ret} with a returner")
    return out


def load_day_sun(channel="air"):
    """Each DAY's sunrise/sunset, UTC, exactly as the L1 CSV carries it: the numbers that day's
    ecological windows were cut with (constant within a day; every spectral day has one).
    Returns {"YYYY-MM-DD": (sr, ss)}; {} when the L1 CSV is absent."""
    p = DESIGN / "data" / f"wildnings_{channel}_L1.csv"
    if not p.exists():
        return {}
    out = {}
    try:
        with open(p, newline="") as fh:
            for r in csv.DictReader(fh):
                sr, ss = _to_float(r.get("sunrise_hour")), _to_float(r.get("sunset_hour"))
                y, m, d = (int(_to_float(r.get(k)) or 0) for k in ("year", "month", "day"))
                if sr is not None and ss is not None and y and m and d:
                    out[f"{y}-{m:02d}-{d:02d}"] = (sr, ss)
    except (OSError, ValueError) as e:
        print(f"  [sun:{channel}] load failed: {e}")
        return {}
    return out


def load_spectral_days(channel="air"):
    """The DAY resolution of spectro/mfcc + the month cells' support, from viz/gen_spectral_days.py
    (data/{pfx}spectral_days.json, ~5 MB, stdlib json, ~0.1 s). Kept in memory and served one
    month at a time on request ({type:"spectral_day"}), never in init. {} when absent."""
    pfx = "" if channel == "air" else f"{channel}_"
    p = DESIGN / "data" / f"{pfx}spectral_days.json"
    if not p.exists():
        print(f"  [days:{channel}] no {p.name} — run viz/gen_spectral_days.py {channel}")
        return {}
    try:
        D = json.loads(p.read_text())
    except (OSError, ValueError) as e:
        print(f"  [days:{channel}] load failed: {e}")
        return {}
    by_month = {}
    for dk in sorted(D.get("days", {})):
        by_month.setdefault(dk[:7], []).append(dk)
    D["by_month"] = by_month
    print(f"  [days:{channel}] {len(D.get('days', {}))} days · {len(by_month)} months")
    return D


def load_month_sun(channel="air"):
    """The month's sunrise/sunset IN THE DATA'S OWN CLOCK, for the hour-of-day views.

    Everything these views plot is UTC: the recorder writes UTC file hours, and the server's
    `sunrise_hour`/`sunset_hour` (the numbers `ecological_window` was cut with) are UTC too -
    June sunrise 3.81, not 4.8. Measured 2026-09-26: the dawn chorus crosses half its rise
    0.88 h before UTC sunrise in BST months (n=14) and 0.93 h before it in GMT months (n=4);
    a local-clock file hour would put the BST months an hour later. spectro.html used to add
    BST to its own NOAA sun, so from April to October its dawn/dusk guides - and the diel
    window a hovered hour voiced - sat one hour late against the data underneath them.

    Mean over the month's days, plus the range: sunrise moves ~1 h across a March, so a
    month's window edge is a band, not a line. Returns {"YYYY-MM": {sr, ss, sr_lo, sr_hi,
    ss_lo, ss_hi}} in fractional UTC hours; {} when the L1 CSV is absent."""
    from collections import defaultdict
    days = defaultdict(dict)                       # (y, m) -> {day: (sr, ss)}: one per DAY, not per window
    for dk, v in load_day_sun(channel).items():
        y, m, d = (int(x) for x in dk.split("-"))
        days[(y, m)][d] = v
    out = {}
    for (y, m), dd in days.items():
        srs = [v[0] for v in dd.values()]; sss = [v[1] for v in dd.values()]
        out[f"{y}-{m:02d}"] = {"sr": round(sum(srs) / len(srs), 3), "ss": round(sum(sss) / len(sss), 3),
                               "sr_lo": round(min(srs), 3), "sr_hi": round(max(srs), 3),
                               "ss_lo": round(min(sss), 3), "ss_hi": round(max(sss), 3)}
    return out


def load_spectral(channel="air"):
    """Extended-spectrogram data: per month, a freq-band x hour-of-day matrix per
    LAYER (indices from spectral_bands.json). Real TOL energy (['tol']) or the
    air-only synthetic false-colour placeholder. Per channel."""
    pfx = "" if channel == "air" else f"{channel}_"
    real = DESIGN / "data" / f"{pfx}spectral_ldfc_monthly.csv"
    syn = DESIGN / "data" / "SYNTHETIC_spectral_ldfc_monthly.csv"     # air-only placeholder
    csv_p = real if real.exists() else (syn if channel == "air" else real)
    meta_p = DESIGN / "data" / f"{pfx}spectral_bands.json"
    if not csv_p.exists() or not meta_p.exists():
        print(f"  [spectral:{channel}] no spectral CSV — run fetch_spectral.py {channel}")
        return [], {}
    try:
        meta = json.loads(meta_p.read_text())
        bands = meta["bands_hz"]; nb = len(bands)
        hours = meta.get("hours", list(range(24)))
        indices = meta.get("indices", ["aci", "ent", "evn"])
        with open(csv_p, newline="") as fh:
            raw = list(csv.DictReader(fh))
    except (OSError, ValueError, KeyError) as e:
        print(f"  [spectral] load failed: {e}"); return [], {}
    from collections import defaultdict
    by_month = defaultdict(dict)
    for r in raw:
        by_month[(int(r["year"]), int(r["month"]))][int(r["hour"])] = r
    sun = load_month_sun(channel)                 # the data's own UTC sun, per month
    out = []
    for (y, m), hrows in sorted(by_month.items()):
        def layer(name):
            # empty/NaN cells (e.g. real TOL's lowest bands, below the Welch
            # resolution floor) -> 0.0 rather than crashing on float("")
            def cell(h, b):
                v = _to_float(hrows[h].get(f"{name}_b{b:02d}")) if h in hrows else None
                return round(v, 4) if v is not None else 0.0
            return [[cell(h, b) for h in hours] for b in range(nb)]  # [band][hour]
        # `have`: the hours that were RECORDED. A missing hour is filled 0.0 below, and 0.0
        # draws as the darkest magma - "the quietest hour" - when it is no recording at all.
        # 13 of 34 air months have holes (winter 2024-12..2026-02 is ~10:00-18:00 only).
        entry = {"key": f"{y}-{m:02d}", "year": y, "month": m, "sun": sun.get(f"{y}-{m:02d}"),
                 "have": sorted(h for h in hrows if h in hours)}
        for name in indices:
            entry[name] = layer(name)
        out.append(entry)
    # DEAD BANDS: zero in every month and every hour. In the hourly source 25, 31.5 and 50 Hz are
    # all-NaN and 40, 63, 80, 100, 125 Hz a constant -120.0 dB; fetch_spectral.py turns both into
    # a clean 0.0 (air AND water), and like a missing hour that 0.0 would draw as "quiet" when it
    # was never measured. The FLOOR band (20 kHz) is added from the day file in build_channel.
    dead = [b for b in range(nb)
            if out and all(v == 0.0 for e in out for v in e[indices[0]][b])]
    smeta = {"bands_hz": bands, "hours": hours, "indices": indices, "clock": "UTC",
             "dead_bands": dead, "synthetic": bool(meta.get("synthetic"))}
    tag = "SYNTHETIC" if smeta["synthetic"] else "real"
    print(f"  [spectral] {len(out)} months x {nb} bands x {len(hours)} h ({tag}, layers={indices})")
    return out, smeta


def load_mfcc(channel="air"):
    """REAL MFCC 'cepstral fingerprint' heatmap: per month, a coefficient x hour
    matrix (spectral SHAPE). From viz/gen_mfcc.py. Each month carries `mat`
    (per-coeff 0..1 normalised, for magma colour) and `raw` (the raw means). Per channel."""
    pfx = "" if channel == "air" else f"{channel}_"
    csv_p = DESIGN / "data" / f"{pfx}mfcc_monthly.csv"
    meta_p = DESIGN / "data" / f"{pfx}mfcc_meta.json"
    if not csv_p.exists() or not meta_p.exists():
        print(f"  [mfcc:{channel}] no mfcc CSV — run gen_mfcc.py {channel}")
        return [], {}
    try:
        meta = json.loads(meta_p.read_text())
        nc = int(meta["n_coeffs"])
        hours = meta.get("hours", list(range(24)))
        with open(csv_p, newline="") as fh:
            raw = list(csv.DictReader(fh))
    except (OSError, ValueError, KeyError) as e:
        print(f"  [mfcc] load failed: {e}")
        return [], {}
    from collections import defaultdict
    by_month = defaultdict(dict)
    for r in raw:
        by_month[(int(r["year"]), int(r["month"]))][int(r["hour"])] = r
    sun = load_month_sun(channel)                 # the data's own UTC sun, per month
    out = []
    for (y, m), hrows in sorted(by_month.items()):
        def mat(prefix):
            return [[round(float(hrows[h][f"{prefix}{c:02d}"]), 4)
                     if (h in hrows and f"{prefix}{c:02d}" in hrows[h]) else 0.0
                     for h in hours] for c in range(nc)]        # [coeff][hour]
        out.append({"key": f"{y}-{m:02d}", "year": y, "month": m, "sun": sun.get(f"{y}-{m:02d}"),
                    "have": sorted(h for h in hrows if h in hours),     # recorded hours (see load_spectral)
                    "mat": mat("mf"), "raw": mat("r")})
    mmeta = {"n_coeffs": nc, "hours": hours, "clock": "UTC", "labels": meta.get("labels", []),
             "ranges": meta.get("ranges", []),
             "synthetic": bool(meta.get("synthetic")), "note": meta.get("note", "")}
    print(f"  [mfcc] {len(out)} months x {nc} coeffs x {len(hours)} h (real)")
    return out, mmeta


def load_embeddings(channel="air", resolution="month"):
    """PCA/UMAP/SOM embeddings for the scatter (viz/gen_embeddings.py), at the given
    resolution: 'month' (per-(month,diel), ~119 pts) or 'day' (per-(month,day,diel) =
    the raw L1 windows, ~2388 pts). Shared 0..1 space per method; every point carries a
    normalised `ax` dict (the feature-pair dims) + drivers, so one point set drives BOTH
    the feature-pair readings and the embedding readings at that resolution."""
    base = f"{resolution}_embeddings.json"
    p = DESIGN / "data" / (base if channel == "air" else f"{channel}_{base}")
    if not p.exists():
        print(f"  [embed:{channel}:{resolution}] {p.name} not found — run gen_embeddings.py {channel}")
        return {}
    try:
        d = json.loads(p.read_text())
        meta = d.get("meta", {})
        print(f"  [embed:{resolution}] methods={meta.get('methods')}, {meta.get('n_points')} points")
        return d
    except (OSError, ValueError) as e:
        print(f"  [embed:{resolution}] failed: {e}")
        return {}


def load_loadings(channel="air"):
    # PCA loadings for the biplot arrows. AIR = data/pca_loadings.json, the arrows of the SAME
    # re-fit load_l0 takes the air months' positions from (viz/gen_l0.py air month, 2026-09-29);
    # viz/pca_loadings.json (the engine's PCA on the uncorrected column, gen_pca_loadings.py) is the
    # fallback only while data/l0.json is absent, so arrows and dots always come from one fit.
    # WATER = data/water_pca_loadings.json (project-side, from gen_l0.py). Design-folder only.
    if channel == "air":
        p = DESIGN / "data" / "pca_loadings.json"
        if not (p.exists() and (DESIGN / "data" / "l0.json").exists()):
            p = ROOT / "pca_loadings.json"
    else:
        p = DESIGN / "data" / f"{channel}_pca_loadings.json"
    if not p.exists():
        print(f"  [loadings:{channel}] {p.name} not found — run gen_pca_loadings.py / gen_l0.py")
        return {}
    try:
        d = json.loads(p.read_text())
        print(f"  [loadings] {len(d.get('features', []))} PCA loadings "
              f"(EVR {d.get('evr')}, corr {d.get('validation_corr')})")
        return d
    except (OSError, ValueError) as e:
        print(f"  [loadings] failed to read: {e}")
        return {}


def load_day_l0(channel="air"):
    """The DAILY biplot ordination — one point per day (viz/gen_l0.py <ch> day). BOTH
    channels are a project-side RE-FIT here (no engine daily parquet); day-grain PCA /
    KMeans / DBSCAN / IsolationForest. Same schema as the monthly l0 + a `day` field."""
    pfx = "" if channel == "air" else f"{channel}_"
    p = DESIGN / "data" / f"{pfx}day_l0.json"
    if not p.exists():
        print(f"  [l0:{channel}:day] {p.name} not found — run gen_l0.py {channel} day")
        return []
    try:
        out = json.loads(p.read_text())
        print(f"  [l0:{channel}:day] {len(out)} days (biplot re-fit)")
        return out
    except (OSError, ValueError) as e:
        print(f"  [l0:{channel}:day] failed: {e}")
        return []


def load_day_loadings(channel="air"):
    """PCA loadings for the daily biplot arrows (viz/gen_l0.py <ch> day) — project-side
    at day grain, so distinct from the monthly loadings. Design-folder only."""
    pfx = "" if channel == "air" else f"{channel}_"
    p = DESIGN / "data" / f"{pfx}day_pca_loadings.json"
    if not p.exists():
        print(f"  [loadings:{channel}:day] {p.name} not found — run gen_l0.py {channel} day")
        return {}
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError) as e:
        print(f"  [loadings:{channel}:day] failed: {e}")
        return {}


_WEATHER = None
def load_weather():
    """Knepp weather (viz/fetch_weather.py) at three grains, channel-agnostic (same sky
    over air + water). Returns (monthly, daily, diel) maps -> {temp, precip, wind, wind_max}.
    diel is keyed (year, month, day, window) so a per-(day,diel) point gets the weather
    DURING its own window. Cached; empty maps if the CSVs aren't present (lens stays blank)."""
    global _WEATHER
    if _WEATHER is not None:
        return _WEATHER
    import csv

    def rd(name, intcols, strcols=()):
        p = DESIGN / "data" / name
        out = {}
        if not p.exists():
            print(f"  [weather] {name} not found — run fetch_weather.py (lens disabled)")
            return out
        with open(p) as f:
            for row in csv.DictReader(f):
                key = tuple(int(row[c]) for c in intcols) + tuple(row[c] for c in strcols)
                out[key] = {"temp": _to_float(row.get("temp_mean")), "precip": _to_float(row.get("precip_sum")),
                            "wind": _to_float(row.get("wind_mean")), "wind_max": _to_float(row.get("wind_max"))}
        return out
    mo = rd("weather_monthly.csv", ["year", "month"])
    da = rd("weather_daily.csv", ["year", "month", "day"])
    di = rd("weather_diel.csv", ["year", "month", "day"], ["diel"])
    if mo or da:
        print(f"  [weather] {len(mo)} months + {len(da)} days + {len(di)} day×diel (temp/precip/wind)")
    _WEATHER = (mo, da, di)
    return _WEATHER


# ---------------------------------------------------------------------------

# ============================================================================
# v2: the four-layer engine (drone + clave + arp + corpus).
# Replaces the v1 sends (/dark_nav bed+drone morph, /dark_arp ecological chord,
# /dark_corpus cloud, /dark_returner). Protocol and rationale: ../dev/README.md.
#
# Everything is PRECOMPUTED: dev/precompute/*.py writes one parquet per level, so the
# bridge only ever does dict lookups. That is what makes subsets a design-time decision
# rather than a navigation-time cost.
# ============================================================================
DEV_DATA = DESIGN / "dev" / "data"
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
RW_LAST_IDENT = None                      # (table channel, level, subset) actually sent
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


def _rw_dir(tch: str):
    return DEV_DATA if tch == "air" else DEV_DATA / tch


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


def _rw_tables(stat: str, tchan: str = None):
    """The parsed tables for ONE reading, cached, WITHOUT touching RW or RW_STAT.

    Split out of load_rw 2026-09-25 because the push tier needs to LOOK UP the reading the
    listener is not on - the drone row for the other statistic swaps one payload out of the
    other table - and doing that through load_rw would switch the live reading out from under
    them for the length of a hold. A read-only lookup must be a read-only lookup.

    STDLIB ONLY: the launcher resolves a Python that has websockets and python-osc but
    explicitly not pandas, so dev/precompute/rw_tables.py assembles these as JSON.
    Returns None (and says so) if dev/data has not been built. `tchan` defaults to the channel
    in force, so every existing caller reads the tables the listener is hearing."""
    tch = tchan or RW_TCHAN
    if (tch, stat) in _RW_CACHE:
        return _RW_CACHE[(tch, stat)]
    # ATOMIC: build into a local and commit both levels or neither. A half-applied switch
    # would leave L0 on one statistic and L1 on the other, which is unfindable by ear.
    built = {}
    for level in ("L0", "L1"):
        path = _rw_dir(tch) / f"rw_tables_{level}_{stat}.json"
        if not path.exists():
            print(f"  [rw:{tch}:{level}] {path.name} missing, layer silent (run "
                  f"dev/precompute/rw_tables.py{'' if tch == 'air' else ' --channel ' + tch})")
            return None
        with open(path, "r", encoding="utf-8") as fh:
            t = json.load(fh)
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
    if sc_client is None or level not in RW:
        return
    # THE CHANNEL IS PART OF THE IDENTITY: air's and water's `year:2024` are different bodies,
    # each tuned on its own channel's ruler (at L1 all:2023-2026's comb is 153.0 Hz on air and
    # 129.0 Hz on water; year:2024's 154.9 vs 93.9 Hz) - pitch compares within a channel only. Keyed on (level, subset) alone, the first water point
    # after an air one in the same room would play water's gains on AIR's mode table and comb.
    if (RW_TCHAN, level, subset) == RW_LAST_IDENT:
        return
    ident = RW[level]["ident"].get(subset)
    if ident is None:
        return
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
    try:
        sc_client.send_message("/rw_identity", args)
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
    RW_LAST_IDENT = (RW_TCHAN, level, subset)


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
    if sc_client is None or level not in RW:
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
        sc_client.send_message("/rw_drone", [theta, pressure] + gains)
        sc_client.send_message("/rw_clave", [rate, formant, accent])
        arp_args = [gap, len(notes)]
        for f, a, c in notes:
            arp_args += [f, a, c]
        sc_client.send_message("/rw_arp", arp_args)
        sc_client.send_message("/rw_corpus",
                               ([clip] + ([ret] if ret else [])) if clip else [])
        sc_client.send_message("/rw_point", [])
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


def _rw_build_drift(tch: str):
    """Air and another channel must be built with the SAME constants (lattice, contrast,
    pressure, f0 window, mode count) - otherwise an air <-> water switch compares two engines,
    not two recorders. sh_identity.py writes a build_*.json record beside each table set; this
    compares them and says so loudly. Missing records (a table set built before 2026-09-26)
    are reported, not guessed at."""
    diffs, missing = [], []
    for name in ("build_gradient.json", "build_variance.json",
                 "build_L0_gradient.json", "build_L0_variance.json"):
        a, b = _rw_dir("air") / name, _rw_dir(tch) / name
        if not (a.exists() and b.exists()):
            missing.append(name)
            continue
        try:
            ra, rb = json.loads(a.read_text()), json.loads(b.read_text())
        except (OSError, ValueError):
            missing.append(name)
            continue
        for k in sorted(set(ra) | set(rb)):
            if k != "channel" and ra.get(k) != rb.get(k):
                diffs.append(f"{name}:{k} air={ra.get(k)} {tch}={rb.get(k)}")
    if diffs:
        print(f"  [rw] *** {tch} tables were built with DIFFERENT constants from air's - rebuild "
              f"both (dev/README.md): " + "; ".join(diffs[:6]))
    elif missing:
        print(f"  [rw] {tch}: no build record for {', '.join(missing)} - cannot confirm it matches air")


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
# (level, channel) -> {feature: [(RAW value, key), ...]}, filled by load_rows. `drv` is
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
# AUDIBILITY GATES. `basis` is on the wire because risk 5 of the brief is that a convention
# gets quoted as a finding. The body gates are the matched null re-bowing ONE state: 0.60 dB
# rms drone-alone and 0.78 dB in the full mix, converted through RW_DB_PER_PI.
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
# by the body AND by the metre: verified, accent == round(7 - 5*theta/pi) with 0 errors on
# every point of every subset. If the UI renders those as two unrelated rows, a reader hears
# one push twice and concludes the display is broken. Both rows carry `twin`.
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
#       2,388/2,388 today. It is the only option where the row's three chips form ONE
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
    (0.0024 rank01 = 0.0076 rad = ~0.014 dB linearised, 43x under the 0.60 dB null)."""
    push = RW_PUSH.get(level)
    tg, tv = _rw_tables("gradient", tch), _rw_tables("variance", tch)
    if not push or tg is None or tv is None or level not in tg:
        RW_PUSH_OK[level] = False
        RW_PUSH_WHY[level] = "the push side file or the drone tables are missing"
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
        rk = {"gradient": [0] * n, "variance": [0] * n, "mean": [0] * n}
        for i, k in enumerate(ks):
            pg = tg[level]["points"][f"{s}@{k}"]
            pv = tv[level]["points"][f"{s}@{k}"]
            rk["gradient"][i] = max(0, min(n - 1, int(round(pg[0] * (n - 1) / math.pi))))
            rk["variance"][i] = max(0, min(n - 1, int(round(pv[0] * (n - 1) / math.pi))))
            rk["mean"][i] = max(0, min(n - 1,
                                       int(round(((pg[3] / cb) - 0.65) / RW_CLAVE_SWING * (n - 1)))))
        rank_key = {r: [None] * n for r in ("gradient", "variance")}
        for r in rank_key:
            for i, k in enumerate(ks):
                rank_key[r][rk[r][i]] = k
        if any(x is None for r in rank_key for x in rank_key[r]):
            # theta takes exactly n values on the grid pi*k/(n-1), one per row, so the ranks
            # are a permutation. If they are not, the table and the side file disagree about
            # what this subset contains and the drone lookup would land on the wrong row.
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
            "rk": rk, "rank_key": rank_key, "clave_base": cb,
        }
    tol = max(4, 0.005 * len(rows))
    ok = all(w <= tol for w in worst.values())
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
              f"self-check worst drift {max(worst.values())} rank(s) of {len(rows)}")
    return ok


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
    return any(RW_PUSH_OK.values())


def _rw_load_push_channel(tch: str):
    for level in ("L1", "L0"):
        path = _rw_dir(tch) / f"rw_push_{level}.json"
        if not path.exists():
            RW_PUSH_OK[level] = False
            RW_PUSH_WHY[level] = ("the push side file has not been built "
                                  "(run dev/precompute/rw_push.py)")
            print(f"  [rw:push:{tch}:{level}] {path.name} missing, push tier disabled "
                  f"(run dev/precompute/rw_push.py{'' if tch == 'air' else ' --channel ' + tch})")
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                RW_PUSH[level] = json.load(fh)
        except (OSError, ValueError) as e:
            RW_PUSH_OK[level] = False
            RW_PUSH_WHY[level] = f"the push side file could not be read ({e})"
            print(f"  [rw:push:{tch}:{level}] {path.name} unreadable: {e}")
            continue
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
        aud.append(("body", d01 >= thr))
        if d01 < thr:
            near.append(("body",
                         f"the body moves ~{db:.2f} dB, at or under the bow-noise floor"))
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
    return {"moves": moves, "moves_held": held, "bed": bed, "notes": notes,
            "audible": audible, "why": why, "column": column, "rho": rho,
            "twin": twin, "reading": reading_to, "_sends": sends,
            "_verbs": tuple(v for v, _a in sends)}


# ---- WHAT THE LISTENER IS HEARING, IN WORDS ----------------------------------------------
# ON THE WIRE RATHER THAN IN THE PAGE, deliberately. Two consequences of the isolation rule
# have to be SURFACED rather than papered over, and neither is visible from the sound:
#   * clave.metre no longer moves the body, so the verified twin (accent == round(7 - 5*theta
#     /pi), 0 errors on every point of every subset) stops being HEARD as one push arriving
#     twice and becomes a label. The reply has always carried `twin`; now it has to say it.
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
    if sc_client is None:
        return
    try:
        sc_client.send_message("/rw_preview", [verb] + list(args))
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
    global RW_PREVIEW
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
    for verb, args in ev["_sends"]:
        rw_preview_send(verb, args)
    RW_PREVIEW = {"row": row, "dir": direction, "verbs": set(ev["_verbs"]),
                  "t": time.monotonic()}
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
    if held is not None:
        _rw_preview_own(held["verbs"])
    rw_preview_send("end", [])
    if held is not None and "cert" in held["verbs"]:
        _rw_preview_own_cert()


def rw_preview_abort():
    """A navigation or a reading change ends a hold without restoring the OLD point - the
    commit that follows is about to set everything anyway."""
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
        if spec["family"] == "drone" and spec.get("stat") != RW_STAT:
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

    gradient and variance are the same rows under two statistics. They differ in EXACTLY the
    /rw_drone payload - theta, pressure, the 35 gains - and in nothing else: the subset
    identity (comb, base, clave base, all modes), the clave triple, the arp and the corpus are
    identical between them. So there is no retune and no page re-init; SC needs no change.
    Deliberately does NOT clear RW_LAST_IDENT: forcing a re-send would trip the level-default
    branch in rw_send_identity and silently reset the four layer faders."""
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
        # get past: RW_LAST_IDENT is None after a display reload (ws_handler), and then the
        # level branch is exactly what must run - it re-sends the listener's mix to an engine
        # that may have been restarted with its own defaults (review 2026-09-27).
        level = RW_LAST_POINT[0]
        if RW_LAST_IDENT is not None:
            RW_LAST_IDENT = (RW_TCHAN, level, None)
        rw_send_identity(level, RW_SUBSET[level])
    elif RW_LAST_POINT is not None:                # re-voice under the listener's hand
        rw_send_point(RW_LAST_POINT[0], RW_LAST_POINT[1])


def rw_send_mix():
    if sc_client is not None:
        try:
            # SILENCED (a channel without tables is on screen): SC gets zeros, the listener's
            # RW_MIX - what the faders show - is untouched and comes back with the next point.
            sc_client.send_message("/rw_mix", [0.0] * len(RW_MIX) if _RW_SILENCED
                                   else [float(x) for x in RW_MIX])
        except OSError:
            pass

# browser hover -> SC /dark_nav  (bed+drone morph; level 1 = fast arp)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# ECOLOGICAL CHORD arpeggiator -> SC /dark_arp  (harmony denotes soundscape state)
# ---------------------------------------------------------------------------
# The arp is no longer species pitches (those scattered — the CORPUS carries WHICH
# birds). It is the harmonic READING of the point's soundscape state, built from the
# indices so it arpeggiates a real chord at every window AND month:
#   root pitch  <- brightness (Ht): dull = low, bright = high
#   quality     <- bio/anthro balance (RELATIVE): dim -> minor -> dom7 -> major -> maj7
#   direction   <- diel phase: dawn/day ASCEND, dusk/night DESCEND (the daily arc)
#   span        <- bioenergy: an active soundscape adds a 2nd octave (wider arpeggio)
# SC just plays the ordered notes we send, so the whole mapping lives here.

def _midi_to_hz(m):
    return round(440.0 * (2.0 ** ((m - 69) / 12.0)), 2)


def _dv(drv, k, d):
    """Safe float read from a driver dict."""
    try:
        return float(drv.get(k))
    except (TypeError, ValueError):
        return d


def _chord_quality(rel_balance, fault=0.0):
    """Relative bio<->anthro balance (0..1) -> chord-quality gradient. fault forces dim."""
    if fault and fault > 0.5:
        return "dim"
    b = rel_balance
    if b < 0.20:
        return "dim"
    if b < 0.40:
        return "minor"
    if b < 0.60:
        return "dom7"
    if b < 0.80:
        return "major"
    return "maj7"



# ---------------------------------------------------------------------------
# corpus (real bird WAVs) -> SC /dark_corpus  (the SECOND sound strategy)
# ---------------------------------------------------------------------------
# FOCAL model (2026-07-11, Miguel): play ONE clean voice — the point's TOP bird
# (k0) — instead of a top-3 cloud. The cloud surfaced ubiquitous loud species
# (Wood-Pigeon, Coot) that buried the actual top bird. Plus, when the month has a
# RETURNER (a phenological surprise — a migrant back after an absence), we add its
# clip: it's too rare for the top slots but its recording exists, and it's the one
# bird you most want to hear. So a point = [top-bird] (+ [returner] if any).
CORPUS_ROOT = DESIGN / "darkdata" / "corpus"
CORPUS_K = 3
CORPUS_FOCAL_AMP = 1.0
CORPUS_RETURNER_AMP = 0.82      # audible under the focal top bird


def _corpus_focal(getter):
    """The point's FOCAL clip = its top bird (k0), amp 1.0. [] if missing/no file."""
    f = getter("top_species_k0_file")
    if isinstance(f, str) and f.strip():
        p = CORPUS_ROOT / f.strip()
        if p.exists():
            return [(str(p), CORPUS_FOCAL_AMP)]
    return []


def _species_files(getter, kmax=20):
    """{common_name: abs_path} across a row's K slots — used to resolve a returner's
    clip (the returner is one of the conf-gated species, so its clip is in here)."""
    out = {}
    for k in range(kmax):
        c = getter(f"top_species_k{k}_common")
        f = getter(f"top_species_k{k}_file")
        if isinstance(c, str) and c.strip() and isinstance(f, str) and f.strip():
            p = CORPUS_ROOT / f.strip()
            if p.exists():
                out.setdefault(c.strip(), str(p))
    return out




_RW_ISO_WARNED = set()


def legend_relay(m: dict):
    """Browser -> legend. FOUR commands, and a reply for the two that have one to make.

        {cmd:"hold",    row:"<one of the fifteen>", dir:"lo"|"hi"|"same"|"only_lo"|"only_hi"}
        {cmd:"release"}                     ("end" stays an alias FOREVER - see below)
        {cmd:"probe"}                       no sound; what would every row do here?
        {cmd:"mute",    value:0|1}          unchanged, still /rw_master

    Returns the dict to send back to the REQUESTER, or None. The mix echo in ws_handler is
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
        if sc_client is not None:
            try:
                sc_client.send_message("/rw_master", ["mute", int(m.get("value", 0))])
            except OSError:
                pass
        return None
    if cmd:
        print(f"  [rw] legend: unknown command {cmd!r}, ignored")
    return None


def master_relay(m: dict):
    """Browser MASTER control -> SC /rw_master ['vol', 0..1] | ['mute', 0|1].

    This was still addressed to /dark_master after the v2 port, which nothing listens for,
    so the master fader and mute were silently dead."""
    if sc_client is None:
        return
    try:
        if m.get("vol") is not None:
            sc_client.send_message("/rw_master", ["vol", max(0.0, min(1.0, float(m["vol"])))])
        if m.get("mute") is not None:
            sc_client.send_message("/rw_master", ["mute", int(bool(m["mute"]))])
    except (OSError, TypeError, ValueError):
        pass


# ---------------------------------------------------------------------------
# channels: build both air + water bundles; the browser toggles between them
# ---------------------------------------------------------------------------
CHANNELS: dict = {}
SPECIES: dict = {}          # channel -> {"YYYY-MM": [(common, conf, ndet), ...]} for the chorus
CORPUS: dict = {}           # channel -> {"l0": {mkey: [(path, amp)]}, "l1": {widx: [(path, amp)]}}
RETURNER: dict = {}         # channel -> {"l0": {mkey: path|None}, "l1": {widx: path|None}} — the highlight focal
BAL_NORM: dict = {}         # channel -> (lo, hi) balance percentiles, for the RELATIVE chord-quality gradient


# WHAT EACH MONTH ACTUALLY HOLDS (Miguel 2026-09-28: "half-filled dot and text on hover"). A month
# point is one mark, but the months are not equal: Aug 2023 is ten minutes of one day, Sep 2025 is
# daytime only, and no Nov or Dec has a dawn. A month is PARTIAL when a whole time of day is missing
# or it holds under half the usual (median) month's hours - and every month view marks it the same
# way (a half-filled dot, a line in the hover box). From the L1 rows' own recorded minutes.
def month_coverage(rows_c):
    mins = {}
    for r in rows_c:
        mk = f"{r['y']}-{int(r['m']):02d}"
        c = mins.setdefault(mk, {w: 0 for w in DIEL_ORDER})
        if r.get("win") in c:
            c[r["win"]] += int(r.get("nmin") or 0)
    if not mins:
        return {}
    usual = statistics.median(sum(c.values()) for c in mins.values())
    out = {}
    for mk, c in mins.items():
        tot = sum(c.values())
        missing = [w for w in DIEL_ORDER if c[w] < 1]
        thin = tot < 0.5 * usual
        held = [w for w in DIEL_ORDER if c[w] >= 1]
        what = (f"{held[0]}time only" if held == ["day"] else f"{held[0]} only") if len(held) == 1 \
            else ("no " + " or ".join(missing) if missing else "")
        amount = f"{tot} min recorded" if tot < 60 else f"{round(tot / 60)} h recorded"
        out[mk] = {"h": round(tot / 60, 1), "w": {w: round(c[w] / 60, 1) for w in DIEL_ORDER},
                   "missing": missing, "thin": bool(thin), "partial": bool(missing or thin),
                   "why": " \u00b7 ".join(x for x in (what, amount) if x),
                   "usual_h": round(usual / 60)}
    return out


def build_channel(channel):
    rows_c = load_rows(channel)
    roses_c = build_roses(rows_c)
    l0_c = load_l0(channel)
    # balance normalisation (RELATIVE, per channel) for the ecological-chord arp.
    # Knepp balance is always anthro-leaning, so the chord gradient uses the relative
    # position (5th–95th pct across windows) — Alice's "ordering is meaningful".
    _bals = sorted(w["drv"]["balance"] for w in rows_c
                   if isinstance(w["drv"].get("balance"), (int, float)))
    if _bals:
        _blo, _bhi = _bals[int(0.05 * (len(_bals) - 1))], _bals[int(0.95 * (len(_bals) - 1))]
        BAL_NORM[channel] = (_blo, _bhi if _bhi > _blo else _blo + 1e-9)
    else:
        BAL_NORM[channel] = (0.0, 1.0)
    # capture each month's species list for the chorus BEFORE it is dropped from
    # the WS payload (load_l0 keeps _species so we can read it here).
    SPECIES[channel] = {m["key"]: m.get("_species", []) for m in l0_c}
    for m in l0_c:
        m.pop("_species", None)
    # corpus = focal top-bird (+ month's returner), keyed the way the browser nav
    # identifies a point:  L0 -> month key "YYYY-MM"  ·  L1 -> window idx.
    # Popped here so the WS payload stays lean (paths never reach the browser).
    RET = {m["key"]: m.pop("_ret_clip", None) for m in l0_c}    # month -> returner clip path
    # corpus = the point's FOCAL top-bird clip only. The RETURNER (the month's
    # phenological highlight) is voiced SEPARATELY in SC (\rwReturner: centred + a
    # shine), so it stands out as "the one to hear" rather than blending in.
    CORPUS[channel] = {
        "l0": {m["key"]: m.pop("_corpus", []) for m in l0_c},
        "l1": {w["idx"]: w.pop("_corpus", []) for w in rows_c},
    }

    def _ret_if_distinct(mkey, focal_clips):
        rc = RET.get(mkey)                                      # None unless top bird != returner
        return rc if (rc and rc not in {p for p, _a in focal_clips}) else None
    RETURNER[channel] = {
        "l0": {m["key"]: _ret_if_distinct(m["key"], CORPUS[channel]["l0"][m["key"]]) for m in l0_c},
        "l1": {w["idx"]: _ret_if_distinct(f"{w['y']}-{w['m']:02d}", CORPUS[channel]["l1"][w["idx"]]) for w in rows_c},
    }
    _nl0 = sum(1 for v in CORPUS[channel]["l0"].values() if v)
    _nret = sum(1 for v in RETURNER[channel]["l0"].values() if v)
    print(f"  [corpus:{channel}] focal top-bird L0 {_nl0}/{len(l0_c)} · "
          f"returner focal: {_nret} months have a distinct highlight clip")
    loadings_c = load_loadings(channel)
    day_l0_c = load_day_l0(channel)                        # ~730 per-day biplot points (project-side re-fit)
    day_loadings_c = load_day_loadings(channel)
    spectral_c, spectral_meta_c = load_spectral(channel)
    mfcc_c, mfcc_meta_c = load_mfcc(channel)
    # WHICH WINDOWS HAVE A POINT, per month. A recorded hour on the spectral side can name a
    # window the acoustic-index side never saw (air: Dec 2025 and Jan 2026 have night hours in
    # the spectrogram and no night windows in L1), and rw_navigate then falls back to the whole
    # month without a word. The hour-of-day views read this and say "whole month" instead.
    _wins = {}
    for w in rows_c:
        _wins.setdefault(f"{w['y']}-{w['m']:02d}", set()).add(w["win"])
    for e in spectral_c + mfcc_c:
        e["wins"] = [w for w in DIEL_ORDER if w in _wins.get(e["key"], ())]
    # THE DAY RESOLUTION + THE MONTH CELLS' SUPPORT (viz/gen_spectral_days.py). Per month cell:
    # nd = days with that UTC hour recorded, nm = minutes (dropouts excluded), and for spectro
    # the cell's mean in dB so the hover box never depends on a colour scale alone.
    days_c = load_spectral_days(channel)
    day_sun_c = load_day_sun(channel)
    row_index_c = {}                                   # "YYYY-MM-DD" -> {win: widx}, the L1 lookup
    for w in rows_c:
        row_index_c.setdefault(f"{w['y']}-{w['m']:02d}-{w['d']:02d}", {})[w["win"]] = w["idx"]
    if days_c:
        _dm = days_c.get("meta", {})
        spectral_meta_c["floor_bands"] = _dm.get("floor_bands", [])
        spectral_meta_c["support"] = True
        mfcc_meta_c["support"] = True
        _db = _dm.get("d_bands", [])
        for e in spectral_c + mfcc_c:
            sup = days_c.get("months", {}).get(e["key"])
            if not sup:
                continue
            e["days"], e["nd"], e["nm"] = sup["days"], sup["nd"], sup["nm"]
        for e in spectral_c:
            sup = days_c.get("months", {}).get(e["key"])
            if sup:                                    # [band][hour] dB, None for dead bands
                full = [None] * len(spectral_meta_c.get("bands_hz", []))
                for j, b in enumerate(_db):
                    if b < len(full):
                        full[b] = sup["d"][j]
                e["db"] = full
    embeddings_c = load_embeddings(channel, "month")       # ~119 (month,diel) pts
    day_embeddings_c = load_embeddings(channel, "day")     # ~2388 (month,day,diel) pts (raw L1 windows)
    # returner = a month-level phenology signal (air-only; water l0 has returner=None)
    ret = {(m["year"], m["month"]): m.get("returner") for m in l0_c}
    for r in roses_c:
        r["returner"] = ret.get((r["year"], r["month"]))
    for w in rows_c:
        w["returner"] = ret.get((w["y"], w["m"]))
    # Enrich embedding points with top-bird + returner so they show the same detail as
    # the feature-pair readings (not "top bird —"). MONTH points get the month's top bird;
    # DAY points get that window's own top bird (from the matching L1 row).
    def _top_bird(splist):
        best = None
        for s in (splist or []):
            if s and s[0] and (best is None or (s[2] or 0) > (best[2] or 0)):
                best = s
        return best[0] if best else None
    mtop = {mk: _top_bird(sp) for mk, sp in (SPECIES.get(channel) or {}).items()}
    for _method in ("pca", "umap", "som"):
        for _pts in (embeddings_c.get(_method) or {}).values():
            for _pt in _pts:
                _pt["sp"] = mtop.get(_pt.get("key"))
                _pt["returner"] = ret.get((_pt.get("year"), _pt.get("month")))
    win_sp = {(w["y"], w["m"], w["d"], w["win"]): w.get("sp") for w in rows_c}   # per-window top bird
    for _method in ("pca", "umap", "som"):
        for _pts in (day_embeddings_c.get(_method) or {}).values():
            for _pt in _pts:
                _pt["sp"] = win_sp.get((_pt.get("year"), _pt.get("month"), _pt.get("day"), _pt.get("win")))
                _pt["returner"] = ret.get((_pt.get("year"), _pt.get("month")))
    for _d in day_l0_c:                                    # daily biplot points -> their month's returner
        _d["returner"] = ret.get((_d.get("year"), _d.get("month")))
    # WEATHER LENS — attach each point its month's / day's weather (temp/precip/wind),
    # channel-agnostic. Month-grain points get the monthly aggregate; day-grain points
    # (rows, day windows, daily biplot) get that day's. Browser colours / hovers on it.
    wx_m, wx_d, wx_di = load_weather()
    def _diel_wx(y, m, d, win):                        # per-window weather, daily fallback
        return wx_di.get((y, m, d, win)) or wx_d.get((y, m, d))
    for _m in l0_c:                                    # months -> monthly
        _m["wx"] = wx_m.get((_m.get("year"), _m.get("month")))
    for _r in roses_c:
        _r["wx"] = wx_m.get((_r.get("year"), _r.get("month")))
    for _w in rows_c:                                  # L1 windows -> the weather during that diel window
        _w["wx"] = _diel_wx(_w.get("y"), _w.get("m"), _w.get("d"), _w.get("win"))
    for _d in day_l0_c:                                # daily biplot -> that day (diel-agnostic)
        _d["wx"] = wx_d.get((_d.get("year"), _d.get("month"), _d.get("day")))
    for _mth in ("pca", "umap", "som"):
        for _pts in (embeddings_c.get(_mth) or {}).values():
            for _pt in _pts:                           # month embeddings -> monthly
                _pt["wx"] = wx_m.get((_pt.get("year"), _pt.get("month")))
        for _pts in (day_embeddings_c.get(_mth) or {}).values():
            for _pt in _pts:                           # day×diel embeddings -> per-window weather
                _pt["wx"] = _diel_wx(_pt.get("year"), _pt.get("month"), _pt.get("day"), _pt.get("win"))
    return {"rows": rows_c, "roses": roses_c, "l0months": l0_c, "loadings": loadings_c,
            "day_l0months": day_l0_c, "day_loadings": day_loadings_c,
            "spectral": spectral_c, "spectral_meta": spectral_meta_c,
            "mfcc": mfcc_c, "mfcc_meta": mfcc_meta_c,
            "embeddings": embeddings_c, "day_embeddings": day_embeddings_c,
            "coverage": month_coverage(rows_c),
            # never in init (init_payload names its keys): served per month by spectral_day_reply
            "spectral_days": days_c, "day_sun": day_sun_c, "row_index": row_index_c}


def build_combined():
    """The AIR+WATER combined channel — the relationship view. Scatter + biplot use the
    joint data (gen_combined.py); the other views fall back to air. Needs air built first."""
    if not (DESIGN / "data" / "combined_month_embeddings.json").exists():
        return None
    air = CHANNELS.get("air")
    if air is None:
        return None

    def _j(name):
        try:
            return json.loads((DESIGN / "data" / name).read_text())
        except (OSError, ValueError):
            return None
    emb = _j("combined_month_embeddings.json") or {}
    l0 = _j("combined_l0.json") or []
    loadings = _j("combined_pca_loadings.json") or {}
    print(f"  [combined] embeddings {emb.get('meta', {}).get('n_points')} pts · l0 {len(l0)} months · "
          f"xchan {emb.get('meta', {}).get('xchan')}")
    return {"rows": air.get("rows", []), "roses": air.get("roses", []),
            "l0months": l0, "loadings": loadings,
            "spectral": air.get("spectral", []), "spectral_meta": air.get("spectral_meta", {}),
            "mfcc": air.get("mfcc", []), "mfcc_meta": air.get("mfcc_meta", {}),
            "embeddings": emb, "coverage": air.get("coverage", {})}


def rw_prune_hour_views():
    """spectro/mfcc tell the listener which window a cell plays ("you hear the whole month",
    "you hear its dusk"). That is only true if the window is a point in the TABLES that channel
    plays, not merely a row of its L1 CSV. Run AFTER the tables load: keep, per month, the windows
    with an L0 point, and per day, the windows with an L1 point - EACH CHANNEL AGAINST ITS OWN
    TABLES (it pruned water against air's until water had tables of its own)."""
    dropped = 0
    for ch, _b in CHANNELS.items():
        T = _rw_tables(RW_STAT, _rw_table_channel(ch)) if _rw_table_channel(ch) in RW_TABLE_CHANNELS else None
        if not T:
            continue
        P0 = (T.get("L0") or {}).get("points", {}); P1 = (T.get("L1") or {}).get("points", {})
        if not P0 or not P1:
            continue
        for e in _b.get("spectral", []) + _b.get("mfcc", []):
            y, mo = (int(x) for x in e["key"].split("-"))
            keep = [w for w in e.get("wins", []) if f"all:2023-2026@{y}|{mo}|{w}" in P0]
            dropped += len(e.get("wins", [])) - len(keep); e["wins"] = keep
        ri = _b.get("row_index")
        if ri is None:
            continue
        for dk, ws in ri.items():
            y, mo, d = int(dk[:4]), int(dk[5:7]), int(dk[8:])
            keep = {w: i for w, i in ws.items() if f"all:2023-2026@{y}|{mo}|{d}|{w}" in P1}
            dropped += len(ws) - len(keep); ri[dk] = keep
    print(f"  [hour views] kept only windows with a table point ({dropped} dropped across channels)")


def spectral_day_reply(m):
    """{type:"spectral_day", channel, month:"YYYY-MM", kind:"tol"|"mfcc"} -> that month's DAYS.

    Each day is shaped like a month entry so diel.js reads it unchanged: key, sun (the day's
    own, lo == hi), have (recorded hours, dropouts excluded), drop, nw (minutes per hour, 24),
    wins + widx (the L1 windows that exist that day and their row index — the sound at day
    resolution is {type:"drv", level:1, widx}), and the values as ROWS, one per recorded hour
    in `hrs`: v = the day-scale colour 0..1, raw = dB (tol) or the raw coefficient (mfcc).
    Always answers, even with days:[] and a `why`, so a page never waits on a missing file.
    air+water has no spectra of its own and falls back to air, as build_combined does."""
    ch = str(m.get("channel") or "air")
    src = "air" if ch == "air+water" else ch
    month = str(m.get("month") or "")
    kind = "mfcc" if m.get("kind") == "mfcc" else "tol"
    b = CHANNELS.get(src) or {}
    D = b.get("spectral_days") or {}
    out = {"type": "spectral_day", "channel": ch, "month": month, "kind": kind, "days": []}
    if not D:
        out["why"] = "no day-level data - run viz/gen_spectral_days.py " + src
        return out
    meta = D.get("meta", {})
    out["meta"] = {k: meta.get(k) for k in ("bands_hz", "dead_bands", "floor_bands", "t_bands",
                                             "d_bands", "n_coeffs", "labels", "rules", "clock")}
    sun, rix = b.get("day_sun", {}), b.get("row_index", {})
    for dk in D.get("by_month", {}).get(month, []):
        e = D["days"][dk]
        drop = set(e.get("drop", []))
        nw = [0] * 24
        for h, n in zip(e["h"], e["nw"]):
            nw[h] = n
        s = sun.get(dk)
        widx = rix.get(dk, {})
        vals, raws = (e["m"], e["r"]) if kind == "mfcc" else (e["t"], e["d"])
        y, mo, d = (int(x) for x in dk.split("-"))
        out["days"].append({
            "key": dk, "year": y, "month": mo, "day": d,
            "sun": None if not s else {"sr": s[0], "ss": s[1], "sr_lo": s[0], "sr_hi": s[0],
                                       "ss_lo": s[1], "ss_hi": s[1]},
            "have": [h for h in e["h"] if h not in drop], "drop": sorted(drop), "nw": nw,
            "wins": [w for w in DIEL_ORDER if w in widx], "widx": widx,
            "hrs": e["h"], "v": vals, "raw": raws})
    if not out["days"]:
        out["why"] = f"no recorded days in {month}"
    return out


def init_payload(channel):
    ch = channel if channel in CHANNELS else "air"
    b = CHANNELS.get(ch) or {}
    return {"type": "init", "channel": ch,
            "channels": [c for c in ("air", "water", "air+water") if c in CHANNELS],
            "rows": b.get("rows", []), "roses": b.get("roses", []),
            "l0months": b.get("l0months", []), "loadings": b.get("loadings", {}),
            "day_l0months": b.get("day_l0months", []), "day_loadings": b.get("day_loadings", {}),   # daily biplot (DAY↔MONTH)
            "spectral": b.get("spectral", []), "spectral_meta": b.get("spectral_meta", {}),
            "mfcc": b.get("mfcc", []), "mfcc_meta": b.get("mfcc_meta", {}),
            "embeddings": b.get("embeddings", {}),
            "day_embeddings": b.get("day_embeddings", {}),   # daily-resolution point set (scatter DAY↔MONTH toggle)
            "coverage": b.get("coverage", {}),               # per month: hours, per window, partial + why
            "web_control": read_web_control(),
            "n_rows": len(b.get("rows", [])), "diel": DIEL_ORDER,
            "ax_keys": list(AX_COLS.keys()),
            "drv_keys": list(DRV_COLS.keys()) + ["balance"]}


# ---------------------------------------------------------------------------
# WebSocket: init(channel) out; {type:"channel"|"drv"|"legend"|"hover"|"spectral_day"} in
# ---------------------------------------------------------------------------
async def ws_handler(ws):
    global RW_CHANNEL, RW_MIX_USER, RW_LAST_IDENT
    clients.add(ws)
    rw_client_new(ws)                        # takes the sound if nobody holds it (P35)
    # A FRESH PAGE MEANS FORGET WHAT THE ENGINE WAS TOLD. The identity is deduplicated on
    # (level, subset), which is right while one engine runs behind one display - but the two
    # are separate processes with separate launchers, so restarting the sound alone leaves
    # this side certain it has already sent a mode table that the new engine never received.
    # The drone then sits on the SynthDef's flat defaults and every point sounds the same,
    # silently. Clearing here makes "reload the display" the honest remedy it looks like:
    # the next point press re-sends the whole body. The level-default branch in
    # rw_send_identity is safe to re-enter - it is guarded by RW_MIX_USER, so a fader the
    # listener has actually moved survives, and an untouched one is rewritten to the value
    # it already holds.
    RW_LAST_IDENT = None
    try:
        await ws.send(json.dumps(init_payload("air")))
        async for raw in ws:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            t = m.get("type")
            _mix_was = list(RW_MIX)
            if t == "channel":                                   # air <-> water switch
                ch = m.get("channel", "air")
                if ch in CHANNELS:
                    await ws.send(json.dumps(init_payload(ch)))
            elif t == "hover" and m.get("idx") is not None:      # legacy: idx into a channel's rows
                b = CHANNELS.get(m.get("channel", "air")) or {}
                rws = b.get("rows", [])
                i = int(m["idx"])
                if 0 <= i < len(rws):
                    rw_navigate(1, str(m.get("channel", "air")), widx=i, client=ws)
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
                # client=ws: this view takes the sound, and its rooms with it (P35)
                rw_navigate(lvl, ch, mkey=m.get("mkey"), widx=m.get("widx"), win=m.get("win"),
                            client=ws)
            elif t == "select":                                  # the current SELECTION
                # per view (P35): retunes only for the view that is playing - see rw_client_select
                rw_client_select(ws, m.get("level", 1), m.get("subset"))
            elif t == "mix":                                     # the four faders
                for _i, _k in enumerate(("drone", "clave", "arp", "corpus")):
                    if m.get(_k) is not None:
                        RW_MIX[_i] = max(0.0, min(1.0, float(m[_k])))
                RW_MIX_USER = True                   # from here the faders are the listener's
                rw_send_mix()
            elif t == "mixquery":                                # a page asking where the mix is
                pass                                             # the echo below answers it
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
                _reply = legend_relay(m)
                if _reply is not None:
                    await ws.send(json.dumps(_reply))
            elif t == "spectral_day":                            # spectro/mfcc DAY resolution
                # REQUESTER ONLY, like the legend: one page asking for one month of days. The
                # type must NOT start with "legend_" - legend.js routes those to itself.
                await ws.send(json.dumps(spectral_day_reply(m)))
            elif t == "master":                                  # MASTER volume / mute
                master_relay(m)
            elif t == "stat":                                    # which reading the drone is under
                rw_set_stat(m.get("stat"))
            elif t == "loop":                                    # LOOP toggle: 1=loop arp+corpus, 0=one-shot
                if sc_client is not None:
                    try:
                        sc_client.send_message("/dark_loop", [int(bool(m.get("on", 1)))])
                    except OSError:
                        pass

            # THE FADERS RENDER SERVER STATE. This side owns RW_MIX; the pages own only the
            # gesture. Anything that moved the mix without the user touching a fader - a level
            # change applying its defaults, the legacy soundmode preset - used to leave four
            # sliders reading 1.00 over an engine that had arp and corpus at 0, so "the
            # sliders don't work" was really "the sliders were never told". Echo to EVERY
            # client, not just the one that acted, or a second tab drifts the moment you
            # navigate in the first.
            if list(RW_MIX) != _mix_was or t == "mixquery":
                _msg = json.dumps({"type": "mix", "drone": RW_MIX[0], "clave": RW_MIX[1],
                                   "arp": RW_MIX[2], "corpus": RW_MIX[3]})
                for _c in list(clients):
                    try:
                        await _c.send(_msg)
                    except Exception:
                        clients.discard(_c)
    finally:
        clients.discard(ws)
        rw_client_gone(ws)                   # its rooms go with it; it gives up the sound (P35)
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


def serve_http():
    def _end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super(self.__class__, self).end_headers()

    def _do_GET(self):
        # Serve the port triple from THIS PROCESS rather than off disk.  The
        # file .viz_ports.json is removed by the launcher's cleanup trap, so a
        # concurrent launcher run deletes the copy we wrote and a bare-URL page
        # (B2.21 §8) then cannot find our WS port.  The live answer cannot go
        # stale.  (Pattern: iris fix 2026-08-22, manual C5 §5.0.)
        if self.path.split("?")[0] in ("/.viz_ports.json", "/viz_ports.json"):
            body = json.dumps({
            "http": HTTP_PORT, "ws": WS_PORT, "osc": None,
            "session_token": _SESSION_TOKEN, "url": _VIZ_URL,
        }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        SimpleHTTPRequestHandler.do_GET(self)

    handler = type("H", (SimpleHTTPRequestHandler,), {
        "__init__": lambda self, *a, **kw:
            SimpleHTTPRequestHandler.__init__(self, *a, directory=str(ROOT), **kw),
        "log_message": lambda *_: None,
        "do_GET": _do_GET,
        "end_headers": _end_headers,
    })
    HTTPServer(("127.0.0.1", HTTP_PORT), handler).serve_forever()


async def main():
    global main_loop
    main_loop = asyncio.get_running_loop()
    await websockets.serve(ws_handler, "127.0.0.1", WS_PORT)
    print(f"  WS   ws://127.0.0.1:{WS_PORT}")
    print(f"  SC   udp://{SC_HOST}:{SC_PORT}  /rw_* four-layer protocol "
          f"(hover a point to hear it)")
    print(f"  HTTP {_VIZ_URL}")
    await asyncio.Future()


if __name__ == "__main__":
    print("dark_re_wilding viz bridge starting (J1 scatter + J3 roses):")
    if not os.environ.get("VIZ_NO_DEATHWATCH"):
        _start_parent_death_watch()
    for _ch in ("air", "water"):
        if (DESIGN / "data" / f"wildnings_{_ch}_L1.csv").exists():
            print(f"  — building channel: {_ch} —")
            CHANNELS[_ch] = build_channel(_ch)
    _combined = build_combined()                          # air+water relationship view
    if _combined:
        CHANNELS["air+water"] = _combined
    print(f"  channels available: {list(CHANNELS.keys())}")
    print("  — loading the four-layer tables (dev/data) —")
    # Both readings are parsed at boot so the sidebar switch is a dict swap, not a file read.
    # The LAST successful load is the one in force, so the shipped default is committed last
    # rather than left to the order of the preloads; if its tables were never built, fall
    # back to the other reading instead of booting with a silent drone.
    load_rw("gradient"); load_rw("variance")
    if not load_rw(RW_STAT_DEFAULT):
        load_rw("gradient" if RW_STAT_DEFAULT == "variance" else "variance")
    # THE OTHER CHANNELS' TABLES, parsed (not put in force: air stays in force until a water
    # point is pressed). A channel is available only with BOTH readings at BOTH levels, so a stat
    # switch on it can never half-apply; without them it is silent with a reason, never air.
    for _tch in ("water",):
        if _tch in CHANNELS and _rw_tables("gradient", _tch) and _rw_tables("variance", _tch):
            RW_TABLE_CHANNELS.add(_tch)
            print(f"  [rw] {_tch} has its own tables")
            _rw_build_drift(_tch)
        elif _tch in CHANNELS:
            _rw_missing_channel(_tch)
    # The push tier's one side file, plus the per-subset derivation and the self-check that
    # stands between a stale side file and silently wrong sound. Must run AFTER load_rw: it
    # takes its subset membership and all of its own ranks from the tables.
    load_rw_push()
    rw_prune_hour_views()
    sc_client = SimpleUDPClient(SC_HOST, SC_PORT)
    # Serve the display manifest to the pages (C8.8): symlink in viz/ (the
    # HTTP root) -> ../darkdata/manifest.json, self-healed like nova's f32s.
    try:
        _mlink = ROOT / "manifest.json"
        if not _mlink.exists():
            _mlink.symlink_to(Path("..") / "darkdata" / "manifest.json")
    except FileExistsError:
        pass
    except Exception as _e:
        print(f"  [assets] could not link manifest.json into viz/: {_e}")
    _ports_path = ROOT / ".viz_ports.json"
    try:
        _ports_path.write_text(json.dumps({
            "http": HTTP_PORT, "ws": WS_PORT, "osc": None,
            "session_token": _SESSION_TOKEN, "url": _VIZ_URL,
        }))
    except OSError as _e:
        print(f"warn: could not write {_ports_path.name}: {_e}")
    threading.Thread(target=serve_http, daemon=True).start()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  bridge stopped")
