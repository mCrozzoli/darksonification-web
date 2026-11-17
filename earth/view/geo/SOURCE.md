# viz/geo/ — the map's local geography (W3)

| file | what | source |
|---|---|---|
| `reykjanes_coast.geojson` | Reykjanes peninsula land (fill) and shoreline (stroke), box lon −23.05 … −21.60, lat 63.70 … 64.20 | **Natural Earth 1:10m land** (`ne_10m_land.geojson`, public domain), from github.com/nvkelso/natural-earth-vector, downloaded 2026-10-20, sha256 `1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416` (also in the file's `source` block) |

- Made by `viz/tools/gen_coastline.py --src <ne_10m_land.geojson>` (pure Python: a rectangle clip for the fill, the in-box shoreline as lines for the stroke, coordinates rounded to 1e-4°).
- 1:10m is good to roughly a kilometre: right for placing epicentres on a 50 km map, not for anything finer. A finer coast (IMO / LMÍ open data) would need its licence recorded here.
- No tile server is used anywhere (DESIGN §5 B: COEP, licences, offline).
- Fissures and lava outlines are not here. IMO's lava-flow data is never to be published (data/SOURCES.md).
