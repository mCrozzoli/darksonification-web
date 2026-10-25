// dark_svartsengi · source.js — the browser DataSource (CONTRACT v0.2 §7). W3.
//
// One interface, two implementations:
//   StaticSource  fetches viz/data/** (or the dev mock): tiles, events, wave chunks, spectrogram tiles, the latent map.
//                 It also emulates replay-as-live: a replay clock moves now(), data after now() is not yet "arrived",
//                 and subscribe() receives the events and frames as the clock passes them.
//   LiveSource    a StaticSource for the backfill + a WebSocket to pipeline/live_server.py (ws :8821), whose pushes
//                 {type:"frames"|"wave"|"events"} are merged into the same caches. now() = the newest time seen.
//
//   const src = await SvkSource.open({mode: "archive"})
//   src.manifest() · src.tiles(tier, source, t0, t1) · src.events(t0, t1) · src.wave(chan, t0, n) · src.subscribe(cb) · src.now()
//   extras the display needs (not in CONTRACT §7 yet; requested): src.spec(chan, t0, t1), src.latent(station),
//   src.waveSpan(chan, t0, t1), src.dataRoot, src.isMock
//
// Every request stays inside what the manifest says exists (station coverage, tile lists), so a view never asks for
// a file that is not there: an absent file is a gap the display names, not a 404 in the console.
window.SvkSource = (function () {
  "use strict";
  const HOUR = 3600, DAY = 86400;

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const pad2 = (n) => String(n).padStart(2, "0");
  function ymd(t) { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  function hh(t) { return pad2(new Date(t * 1000).getUTCHours()); }
  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  async function getBytes(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.arrayBuffer();
  }

  // ------------------------------------------------------------------------------------------------ O1: readers
  // Bring your own data (DESIGN §6.1, TASKS O1). A reader reads a tree's files by their path inside it (the viz/data
  // layout): json(rel), bytes(rel); has(rel) says whether the tree holds a file (null = ask its manifest). A folder is
  // read in place: nothing is uploaded.
  function urlReader(base) {
    return { kind: "url", base, label: base, json: (rel) => getJSON(base + rel), bytes: (rel) => getBytes(base + rel), has: null };
  }
  // <input webkitdirectory> (Firefox, Safari; Chromium too): the picked files by their path inside the tree
  function fileListReader(entries, prefix, label) {
    const map = new Map();
    for (const { rel, file } of entries) if (rel.startsWith(prefix)) map.set(rel.slice(prefix.length), file);
    const get = (rel) => { const f = map.get(rel); if (!f) throw new Error(`not in the folder: ${rel}`); return f; };
    return { kind: "folder", via: "files", label, json: async (rel) => JSON.parse(await get(rel).text()), bytes: async (rel) => get(rel).arrayBuffer(),
             has: (rel) => map.has(rel), size: map.size };
  }
  // showDirectoryPicker (Chromium): a directory handle, walked a folder at a time (each folder's handle cached)
  function dirHandleReader(root, prefix, label) {
    const dirs = new Map();
    const dirOf = (parts) => {
      const key = parts.join("/");
      if (!dirs.has(key)) dirs.set(key, parts.length ? dirOf(parts.slice(0, -1)).then((d) => d.getDirectoryHandle(parts[parts.length - 1])) : Promise.resolve(root));
      return dirs.get(key);
    };
    const file = async (rel) => { const parts = (prefix + rel).split("/").filter(Boolean), name = parts.pop(); return (await (await dirOf(parts)).getFileHandle(name)).getFile(); };
    return { kind: "folder", via: "handle", label, handle: root, file, json: async (rel) => JSON.parse(await (await file(rel)).text()), bytes: async (rel) => (await file(rel)).arrayBuffer(), has: null };
  }
  // ----- W1's portable tree (CONTRACT 0.15, and 0.16 for a tiles-only tree naming a raw miniSEED folder; W1 note §16.1,
  // pipeline/tree_check.py): the loader mirrors the checker's
  // steps 1–5. The index digests are checked with SubtleCrypto; the sizes where the folder can tell them cheaply; every
  // file's sha256 only on request (verifyTree). A tree marked public: false is the researcher's own: it never leaves the page
  const TREE_VERSIONS = ["0.15", "0.16"];                    // tree_check's KNOWN_VERSIONS
  const ROOT_KEYS = ["schema", "schema_version", "made", "pipeline", "public", "manifest", "t0", "t_end", "stations", "export", "index", "dirs", "n_files", "bytes", "tree_sha256"];
  const isNet = (e) => e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(String(e && e.message));
  async function sha256Hex(x) {
    const b = typeof x === "string" ? new TextEncoder().encode(x) : x, h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
    return Array.from(h, (v) => v.toString(16).padStart(2, "0")).join("");
  }
  const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);            // Python's sort on ASCII names
  async function checkTree(raw, doc, sizeOf, listAll) {
    // 1. the root
    const miss = ROOT_KEYS.filter((k) => !(k in doc));
    if (doc.schema !== "darkearth_tree") throw new Error(`darkearth_tree.json says schema "${doc.schema}", not a Dark Earth tree`);
    if (!TREE_VERSIONS.includes(String(doc.schema_version))) throw new Error(`a tree of schema version ${doc.schema_version}: this page reads ${TREE_VERSIONS.join(", ")}`);
    if (miss.length) throw new Error(`darkearth_tree.json has no ${miss.join(", ")}`);
    if (("kind" in doc && doc.kind !== doc.schema) || ("contract" in doc && String(doc.contract) !== String(doc.schema_version))) throw new Error("darkearth_tree.json's kind / contract disagree with its schema / schema_version");
    //    a raw miniSEED folder beside the tiles (not indexed) is a 0.16 tree's, a relative folder inside the tree
    if (doc.raw && doc.raw.dir) {
      if (String(doc.schema_version) === "0.15") throw new Error("this tree names a raw folder but says version 0.15: a raw folder needs a 0.16 tree (pipeline.tree_tiles_only --raw-dir writes one)");
      if (/^\//.test(doc.raw.dir) || String(doc.raw.dir).split("/").includes("..")) throw new Error(`its raw folder "${doc.raw.dir}" must be a relative folder inside the tree`);
    }
    // 2. every directory's index, its digest, n and bytes; the tree's digest
    const indexed = new Map(), warn = [];
    const ds = Object.keys(doc.dirs || {}).sort(byCode);
    const rowsOf = await Promise.all(ds.map(async (d) => {
      try { return (await raw.json((d ? d + "/" : "") + "_files.json")).files || []; }
      catch (e) { if (isNet(e)) throw e; throw new Error(`${d || "the top folder"} has no _files.json: the tree is incomplete`); }
    }));
    for (let k = 0; k < ds.length; k++) {
      const d = ds[k], info = doc.dirs[d], rows = [...rowsOf[k]].sort((a, b) => byCode(a.name, b.name));
      const lines = rows.map((r) => `${r.name}\t${r.size}\t${r.sha256}\n`).join("");
      if ((await sha256Hex(lines)) !== info.sha256 || rows.length !== info.n || rows.reduce((a, r) => a + r.size, 0) !== info.bytes)
        throw new Error(`the index of ${d || "the top folder"} does not match darkearth_tree.json (was a file changed after the export?)`);
      for (const r of rows) indexed.set(d ? `${d}/${r.name}` : r.name, r);
    }
    const tl = ds.map((d) => `${d}\t${doc.dirs[d].n}\t${doc.dirs[d].bytes}\t${doc.dirs[d].sha256}\n`).join("");
    if ((await sha256Hex(tl)) !== doc.tree_sha256) throw new Error("the tree's digest (tree_sha256) does not match its directories");
    //    …and the sizes, where the folder can say them (a server cannot without a request per file: its index is checked)
    let sizes = "not checked (a server)";
    if (sizeOf) {
      const all = [...indexed.values()].map((r, n) => [[...indexed.keys()][n], r]), cap = 3000;
      const pick = all.length <= cap ? all : all.filter((_, n) => n % Math.ceil(all.length / cap) === 0);
      const bad = [];
      for (const [rel, r] of pick) { const sz = await sizeOf(rel); if (sz == null) bad.push(`missing ${rel}`); else if (sz !== r.size) bad.push(`size ${rel}`); if (bad.length > 4) break; }
      if (bad.length) throw new Error(`the folder does not match its index: ${bad.slice(0, 3).join("; ")}${bad.length > 3 ? "; …" : ""}`);
      sizes = pick.length === all.length ? `all ${all.length} files` : `${pick.length} of ${all.length} files, spread through the tree`;
    }
    // 3. nothing outside the index (a folder only; the system's own .DS_Store and other dotfiles are not the tree's)
    const rawDir = doc.raw && doc.raw.dir ? String(doc.raw.dir).replace(/\/+$/, "") + "/" : null;   // checked in step 1
    if (listAll) {
      const extra = listAll().filter((rel) => !indexed.has(rel) && !/(^|\/)(darkearth_tree\.json|_files\.json)$/.test(rel) && !/(^|\/)\./.test(rel) && !(rawDir && rel.startsWith(rawDir)));
      if (extra.length) warn.push(`${extra.length} file${extra.length === 1 ? "" : "s"} outside the tree's index, left alone (${extra.slice(0, 2).join(", ")}${extra.length > 2 ? ", …" : ""})`);
    }
    return { indexed, warn, sizes, rawDir };
  }
  // steps 4–5: the manifest against the root, and everything it names in the index
  function checkTreeManifest(doc, m, indexed) {
    if (!indexed.has(doc.manifest)) throw new Error("the manifest is not in the tree's index");
    if (String(m.contract) !== String(doc.schema_version) || m.public !== doc.public) throw new Error("the manifest's contract or public flag differs from darkearth_tree.json");
    const ids = (a) => (a || []).map((s) => s.id).join(",");
    if (ids(m.stations) !== ids(doc.stations)) throw new Error("the manifest's stations differ from darkearth_tree.json's");
    const missing = [];
    for (const [tier, srcs] of Object.entries(m.tiles || {})) for (const [sr, ks] of Object.entries(srcs || {})) for (const k of ks || []) { const rel = `tiles/${tier}/${sr}/${k}.json`; if (!indexed.has(rel)) missing.push(rel); }
    for (const [kind, ext] of [["wave", "u16"], ["spec", "u8"]]) for (const [chan, v] of Object.entries(m[kind] || {})) for (const h of v.hours || []) for (const e of ["json", ext]) { const rel = `${kind}/${chan}/${h}.${e}`; if (!indexed.has(rel)) missing.push(rel); }
    if (missing.length) throw new Error(`the manifest names ${missing.length} file${missing.length === 1 ? "" : "s"} the tree does not hold (${missing[0]}${missing.length > 1 ? ", …" : ""})`);
  }
  // what a tree must have for the page to read it; a plain sentence otherwise
  function checkManifest(m) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return "its manifest is not a JSON object";
    const miss = [];
    if (!isFinite(m.t0) || !isFinite(m.t_end)) miss.push("t0 / t_end");
    if (!m.tiers || typeof m.tiers !== "object") miss.push("tiers");
    if (!Array.isArray(m.stations)) miss.push("stations");
    if (!m.tiles || typeof m.tiles !== "object") miss.push("tiles (the tile index)");
    return miss.length ? `its manifest has no ${miss.join(", ")}` : null;
  }
  // a tree: W1's portable tree (darkearth_tree.json, checked as tree_check does) or a plain viz/data copy (a manifest.json
  // and nothing else: shown as "a plain tile tree", unchecked). → {io, manifest, doc, label, kind, check} or throws a
  // sentence a person can act on
  async function treeFrom(rawIo, label, kind, { plainOnly = false, sizeOf = null, listAll = null, rawEntries = null } = {}) {
    let doc = null;
    if (!plainOnly) try { doc = await rawIo.json("darkearth_tree.json"); } catch (e) { if (isNet(e)) throw e; doc = null; }
    let manifest, check = null;
    if (doc) {
      check = await checkTree(rawIo, doc, sizeOf, listAll);
      try { manifest = await rawIo.json(doc.manifest); } catch (e) { if (isNet(e)) throw e; throw new Error(`darkearth_tree.json names its manifest ${doc.manifest}, which could not be read`); }
      const bad = checkManifest(manifest); if (bad) throw new Error(`not a tree the page can read: ${bad}`);
      checkTreeManifest(doc, manifest, check.indexed);
    } else {
      try { manifest = await rawIo.json("manifest.json"); }
      catch (e) { if (isNet(e)) throw e; throw new Error("this is not a Dark Earth tree: no darkearth_tree.json and no manifest.json at its top"); }
      const bad = checkManifest(manifest); if (bad) throw new Error(`not a tree the page can read: ${bad}`);
    }
    // 0.16: a tiles-only tree may keep its raw miniSEED in a folder beside the tiles (doc.raw.dir, not indexed): the page
    // reads it as a raw source for the waveforms (and the spectrograms computed from them)
    let rawPart = null;
    if (check && check.rawDir) {
      if (!rawEntries) check.warn.push(`its raw miniSEED (${check.rawDir}) is read from a folder, not from a server`);
      else { const ents = await rawEntries(check.rawDir); if (ents.length) { try { rawPart = await rawFrom(ents, `${label}/${check.rawDir}`, kind); } catch (e) { check.warn.push(`its raw folder ${check.rawDir}: ${e.message}`); } } }
    }
    return { io: rawIo, manifest, doc, label: (doc && doc.title) || label, name: label, kind, plain: !doc, check, public: doc ? !!doc.public : !!manifest.public, rawPart };
  }
  // every file's sha256 against the index (on request: a big tree takes a while). onStep(done, total)
  async function verifyTree(tree, onStep) {
    if (!tree.check) throw new Error("a plain tile tree has no index to verify against");
    const all = [...tree.check.indexed.entries()], bad = [];
    for (let n = 0; n < all.length; n++) {
      const [rel, r] = all[n];
      try { if ((await sha256Hex(await tree.io.bytes(rel))) !== r.sha256) bad.push(rel); } catch (_) { bad.push(rel); }
      if (onStep && (n % 10 === 9 || n === all.length - 1)) onStep(n + 1, all.length);
    }
    return { n: all.length, bad };
  }
  // the picked files (webkitdirectory): the tree's top is the shallowest folder holding darkearth_tree.json or manifest.json
  async function treeFromFiles(fileList) {
    const entries = Array.from(fileList, (f) => ({ rel: f.webkitRelativePath || f.relPath || f.name, file: f }));
    if (!entries.length) throw new Error("the folder is empty");
    const tops = entries.filter((e) => /(^|\/)(darkearth_tree|manifest)\.json$/.test(e.rel)).map((e) => e.rel.replace(/[^/]*$/, ""));
    if (!tops.length) return rawFrom(entries, entries[0].rel.includes("/") ? entries[0].rel.split("/")[0] : "your folder", "folder");   // no tree: raw miniSEED?
    const top = tops.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
    const name = (top.split("/").filter(Boolean).pop()) || entries[0].rel.split("/")[0] || "your folder";
    const io = fileListReader(entries, top, name);
    const map = new Map(entries.filter((e) => e.rel.startsWith(top)).map((e) => [e.rel.slice(top.length), e.file]));
    return treeFrom(io, name, "folder", { sizeOf: async (rel) => (map.has(rel) ? map.get(rel).size : null), listAll: () => [...map.keys()],
                                          rawEntries: async (dir) => [...map].filter(([rel]) => rel.startsWith(dir) && !/(^|\/)\./.test(rel)).map(([rel, file]) => ({ rel, file })) });
  }
  // a directory handle (showDirectoryPicker): the tree at its top, or in the one subfolder that holds it
  async function treeFromHandle(handle) {
    const has = async (d, n) => { try { await d.getFileHandle(n); return true; } catch (_) { return false; } };
    let prefix = "";
    if (!(await has(handle, "darkearth_tree.json")) && !(await has(handle, "manifest.json"))) {
      for await (const [n, h] of handle.entries()) if (h.kind === "directory" && ((await has(h, "darkearth_tree.json")) || (await has(h, "manifest.json")))) { prefix = n + "/"; break; }
    }
    const name = (prefix ? prefix.slice(0, -1) : handle.name) || "your folder";
    if (!prefix && !(await has(handle, "darkearth_tree.json")) && !(await has(handle, "manifest.json"))) {
      // no tree at its top or one folder down: raw miniSEED? Every file, walked (dotfiles left out)
      const entries = [], walk = async (d, path) => {
        for await (const [n, h] of d.entries()) {
          if (n.startsWith(".") || entries.length > 50000) continue;
          if (h.kind === "directory") await walk(h, path + n + "/"); else entries.push({ rel: path + n, file: await h.getFile() });
        }
      };
      await walk(handle, "");
      return rawFrom(entries, handle.name || "your folder", "folder");
    }
    const io = dirHandleReader(handle, prefix, name);
    const rawEntries = async (dir) => {
      let d = handle; for (const p of (prefix + dir).split("/").filter(Boolean)) { try { d = await d.getDirectoryHandle(p); } catch (_) { return []; } }
      const out = [], walk = async (h, path) => { for await (const [n, x] of h.entries()) { if (n.startsWith(".") || out.length > 50000) continue; if (x.kind === "directory") await walk(x, path + n + "/"); else out.push({ rel: dir + path + n, file: await x.getFile() }); } };
      await walk(d, ""); return out;
    };
    return treeFrom(io, name, "folder", { sizeOf: async (rel) => { try { return (await io.file(rel)).size; } catch (_) { return null; } }, rawEntries });
  }
  // a URL to the same tree served as static files (the researcher's own server). It needs CORS (Access-Control-Allow-
  // Origin for this page); a blocked or unreachable server is one plain sentence
  async function treeFromUrl(url) {
    let u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) throw new Error("a server address starts with https:// (or http:// on your own machine)");
    if (location.protocol === "https:" && /^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(u)) throw new Error("this page is https, so it cannot read an http:// server (mixed content): serve the tree over https");
    const plainOnly = /manifest\.json$/.test(u);                 // a manifest's own URL: a plain tree, nothing else is asked for
    u = u.replace(/(darkearth_tree|manifest)\.json$/, "");
    if (!u.endsWith("/")) u += "/";
    try { return await treeFrom(urlReader(u), u, "url", { plainOnly }); }
    catch (e) {
      const own = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(u) && location.protocol === "https:";
      // a server on the researcher's own machine read from the https page: each browser has its own rule (W5, 2026-10-25)
      if (isNet(e) && own) throw new Error(`could not read ${u}. A server on your own machine read from this https page works in Firefox, in Chrome after you allow its "local network access" prompt, and not in Safari (mixed content): there, choose the folder instead. The server must also send Access-Control-Allow-Origin: ${location.origin} (or *)`);
      if (isNet(e)) throw new Error(`could not read ${u}: the server is unreachable, or it does not let this page read it (CORS). A tree for this page needs the header Access-Control-Allow-Origin: ${location.origin} (or *) on its files`);
      throw e;
    }
  }
  // the merged view's manifest: stations by id (the loaded fields win, coverage unioned), the tile index by tier and
  // station only (each tree keeps its own tile grid: its t0), wave/spec hours unioned (hours are the clock's, grid-free),
  // ranges kept from the published data (new keys added), t0/t_end widened. events, eruptions, body … from the loaded
  // tree when it has them (W1's trees have none: the published ones stay)
  function unionSpans(spans) {
    const s = spans.filter((x) => x && isFinite(x[0]) && isFinite(x[1])).map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]), out = [];
    for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push(x); }
    return out;
  }
  function mergeManifests(P, L, label) {
    const M = JSON.parse(JSON.stringify(P));
    const byId = new Map((M.stations || []).map((s) => [s.id, s]));
    for (const s of L.stations || []) {
      const p = byId.get(s.id);
      if (!p) { M.stations.push({ ...s, _from: "loaded" }); continue; }
      // the loaded fields win where they have a value (a raw folder knows no positions: the published ones stay); a
      // position comes as one set (lat, lon, elev, status, source, error, pending), so no published ± is left on it
      const POS = ["lat", "lon", "elev", "pos_status", "pos_source", "pos_err_m", "pending"];
      for (const [k, v] of Object.entries(s)) if (v != null && k !== "coverage" && !POS.includes(k)) p[k] = v;
      if (isNum(s.lat) && isNum(s.lon)) for (const k of POS) p[k] = s[k] ?? null;
      p.coverage = unionSpans([...(p.coverage || []), ...(s.coverage || [])]); p._from = "loaded";
    }
    M.tiers = { ...(L.tiers || {}), ...(P.tiers || {}) };
    M.tiles = M.tiles || {};
    for (const [tier, bySrc] of Object.entries(L.tiles || {})) { M.tiles[tier] = M.tiles[tier] || {}; for (const sr of Object.keys(bySrc || {})) M.tiles[tier][sr] = M.tiles[tier][sr] || []; }
    for (const kind of ["wave", "spec"]) for (const [chan, v] of Object.entries(L[kind] || {})) {
      M[kind] = M[kind] || {};
      const p = M[kind][chan] || {};
      M[kind][chan] = { ...p, ...v, hours: [...new Set([...(p.hours || []), ...(v.hours || [])])].sort() };
    }
    for (const k of ["events", "eruptions", "body", "deflation_events"]) if (L[k]) M[k] = L[k];
    if (Array.isArray(L.fountains)) M.fountains = L.fountains;
    if (L.latent) M.latent = { ...(M.latent || {}), ...L.latent };
    M.ranges = { ...(L.ranges || {}), ...(P.ranges || {}) };
    if (isFinite(L.t0)) M.t0 = Math.min(P.t0, L.t0);
    if (isFinite(L.t_end)) M.t_end = Math.max(P.t_end, L.t_end);
    M._loaded = { label, built: L.built || null, contract: L.contract || null };
    return M;
  }
  // ----- O1 step 3: raw miniSEED (CONTRACT 0.16). A folder of SDS, year or loose files: every file opened by its first
  // header (not its name) and its last; channels and stations from the headers. The manifest it gets is a seismic
  // station's: coverage from the files' spans, the wave hours they overlap, no tiles yet (the feature engine comes with
  // W1's spec), no positions (StationXML or an FDSN station service gives them)
  async function rawFrom(entries, label, kind) {
    if (!window.SvkMseed) throw new Error("the miniSEED reader is not loaded");
    const files = entries.map((e) => { try { e.file.relPath = e.rel; } catch (_) {} return e.file; });
    const S = await window.SvkMseed.scanFiles(files);
    if (!S.files.length) throw new Error("this is not a Dark Earth tree, and there is no miniSEED in it either (no darkearth_tree.json, no manifest.json, no SEED records)");
    const chans = new Map();
    for (const m of S.files) { m.spanS = await m.span(); if (!chans.has(m.nslc)) chans.set(m.nslc, []); chans.get(m.nslc).push(m); }
    const byStation = new Map();
    for (const [chan, fl] of chans) {
      const sid = chan.split(".").slice(0, 3).join("."), cha = chan.split(".")[3];
      if (!byStation.has(sid)) byStation.set(sid, { chans: [], spans: [] });
      const st = byStation.get(sid); st.chans.push(cha); st.spans.push(...fl.map((m) => m.spanS));
    }
    let t0 = Infinity, t1 = -Infinity;
    for (const fl of chans.values()) for (const m of fl) { t0 = Math.min(t0, m.spanS[0]); t1 = Math.max(t1, m.spanS[1]); }
    const hoursOf = (fl) => { const hs = new Set(); for (const m of fl) for (let h = Math.floor(m.spanS[0] / HOUR) * HOUR; h < m.spanS[1]; h += HOUR) hs.add(`${ymd(h)}/${hh(h)}`); return [...hs].sort(); };
    const manifest = {
      contract: "0.16", kind: "raw_mseed", public: false, built: null, t0: Math.floor(t0 / DAY) * DAY, t_end: t1, tiers: {}, tiles: {}, spec: {},
      stations: [...byStation].map(([id, st]) => ({ id, kind: "seismic", channels: st.chans.sort((a, b) => (a[0] !== "H") - (b[0] !== "H") || "ZNE".indexOf(a.slice(-1)) - "ZNE".indexOf(b.slice(-1))),
                                                   coverage: unionSpans(st.spans), label: `${id.split(".")[1] || id}: raw miniSEED` })),
      wave: Object.fromEntries([...chans].map(([c, fl]) => [c, { fs: fl[0].fs, hours: hoursOf(fl) }])),
    };
    await filterTables();
    return { raw: true, kind, label, name: label, manifest, chans, layout: S.layout, skipped: S.skipped, public: false, plain: false, check: null, io: null, doc: null, rates: rateNotes(manifest, chans) };
  }
  // the worker that decodes (mseed/worker.js), one per page, its requests by id; a stale request can be cancelled
  let WK = null, wkId = 0;
  const wkWait = new Map();
  function worker() {
    if (WK) return WK;
    WK = new Worker("mseed/worker.js");
    WK.onmessage = (e) => {
      const m = e.data, p = wkWait.get(m.id); if (!p) return;
      if (m.progress != null && !m.rows && !m.error) { if (p.onProgress) p.onProgress(m.progress); return; }
      wkWait.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m);
    };
    WK.onerror = (e) => { for (const [, p] of wkWait) p.reject(new Error(`the miniSEED worker failed: ${e.message || "?"}`)); wkWait.clear(); };
    return WK;
  }
  // the feature engine over [from, to) (worker op "features"); onProgress(0..1); .cancel() stops it between pushes
  // W1's multi-rate table (mseed/filters.json, a copy of pipeline/tests/golden/filters.json: one table per rate, each
  // holding only the bands that fit below 0.9 × Nyquist). Fetched once; it sets the rates the engine computes
  let FILTER_TABLES = null, RATE_NOTE = {};
  async function filterTables() {
    if (!FILTER_TABLES) FILTER_TABLES = fetch("mseed/filters.json").then((r) => (r.ok ? r.json() : null)).catch(() => null).then((t) => {
      if (!t || !t.rates) return [];
      TABLE_FS = Object.values(t.rates).map((r) => +r.fs).sort((a, b) => a - b);
      RATE_NOTE = Object.fromEntries(Object.values(t.rates).filter((r) => r.missing && Object.keys(r.missing).length).map((r) => [+r.fs, Object.values(r.missing).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(([lo, hi]) => `${lo}–${hi}`)]));
      return [t];
    });
    return FILTER_TABLES;
  }
  // a raw source's stations by the rate of their vertical channel: the ones the engine cannot compute (no table), and
  // the ones it computes without some bands (their features null), for the data-source line
  function rateNotes(manifest, chans) {
    const out = { none: [], partial: [] };
    for (const st of manifest.stations || []) {
      const fl = {}; for (const [c, l] of chans) if (c.startsWith(st.id + ".")) fl[c.split(".")[3]] = l;
      const z = rolesFor(fl).Z; if (!z) continue;
      const fs = +fl[z][0].fs, sta = st.id.split(".")[1] || st.id;
      if (!TABLE_FS.includes(fs)) out.none.push({ sta, fs }); else if (RATE_NOTE[fs]) out.partial.push({ sta, fs, bands: RATE_NOTE[fs] });
    }
    return out;
  }
  async function wkFeatures(msg, onProgress) {
    const filters = await filterTables(), id = ++wkId, w = worker();
    const pr = new Promise((resolve, reject) => wkWait.set(id, { resolve, reject, onProgress }));
    w.postMessage({ id, op: "features", filters, ...msg });
    pr.cancel = () => w.postMessage({ op: "cancel", target: id });
    return pr;
  }
  function wkRead(files, t0, t1) {
    const id = ++wkId, w = worker();
    const pr = new Promise((resolve, reject) => wkWait.set(id, { resolve, reject }));
    w.postMessage({ id, op: "read", files: files.map((m) => m.blob), t0, t1 });
    pr.cancel = () => w.postMessage({ op: "cancel", target: id });
    return pr;
  }
  async function openMerged(published, tree) {
    const L = tree.fdsn ? new FdsnSource(tree.manifest, tree.chans, tree.fdsn)                       // an FDSN service, an hour per request
      : tree.raw ? new RawSource(tree.manifest, tree.chans)                                           // raw miniSEED, read by the worker
      : tree.rawPart ? new TreeRawSource(tree, new RawSource(tree.rawPart.manifest, tree.rawPart.chans))   // tiles + raw beside them
      : new StaticSource(tree.kind === "url" ? tree.io.base : "", tree.manifest, tree.io);            // a tree, on its own grid
    const src = new MergedSource(published, L, tree);
    await src.loadEvents().catch((e) => console.warn("[source] events not loaded", e));
    await src.loadEruptions().catch((e) => console.warn("[source] eruptions not loaded", e));
    return src;
  }
  // a folder handle remembered per viewer (Chromium; IndexedDB). Every call is wrapped: a private window or blocked
  // storage just forgets it
  const HANDLE_DB = "svk_o1", HANDLE_KEY = "folder";
  function idb(mode, fn) {
    return new Promise((res) => {
      try {
        const rq = indexedDB.open(HANDLE_DB, 1);
        rq.onupgradeneeded = () => { try { rq.result.createObjectStore("h"); } catch (_) {} };
        rq.onerror = () => res(null);
        rq.onsuccess = () => { try { const tx = rq.result.transaction("h", mode), st = tx.objectStore("h"), r = fn(st); tx.oncomplete = () => res(r && "result" in r ? r.result : true); tx.onerror = () => res(null); } catch (_) { res(null); } };
      } catch (_) { res(null); }
    });
  }
  const handleStore = {
    save: (h) => idb("readwrite", (st) => st.put(h, HANDLE_KEY)),
    load: () => idb("readonly", (st) => st.get(HANDLE_KEY)),
    clear: () => idb("readwrite", (st) => st.delete(HANDLE_KEY)),
  };

  // ------------------------------------------------------------------------------------------------ a spectrogram in the page
  // W1 §15.1 (spec_files false): the same tile shape as W1's spectrogram files (CONTRACT §4.2: frames × bins, uint8, log-f
  // bins 0.2–50 Hz, 10·log10 PSD in counts²/Hz, a Hann window of 10.24 s centred on each frame), at one frame per 2 s
  // (half W1's rate: an hour costs ~1800 FFTs of 1024 points). Frames touching a gap are left at 0 and listed.
  const SPEC_NFFT = 1024, SPEC_DT = 2, SPEC_BINS = 96, SPEC_FLO = 0.2, SPEC_FHI = 50;
  function fft(re, im) {                                  // in place, radix 2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  async function specFromWave(c, range) {
    const fs = c.fs, x = c.x, nf = Math.floor(x.length / (fs * SPEC_DT)), N = SPEC_NFFT, half = N / 2;
    const win = new Float64Array(N); let wss = 0;
    for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); wss += win[i] * win[i]; }
    const edges = Array.from({ length: SPEC_BINS + 1 }, (_, k) => SPEC_FLO * (SPEC_FHI / SPEC_FLO) ** (k / SPEC_BINS));
    const df = fs / N, db = new Float32Array(nf * SPEC_BINS), bad = [];
    const re = new Float64Array(N), im = new Float64Array(N), psd = new Float64Array(half + 1);
    for (let f = 0; f < nf; f++) {
      if (f % 150 === 149) await new Promise((r) => setTimeout(r, 0));    // yield: an hour is ~1800 FFTs, never one long block
      const ctr = Math.round((f + 0.5) * SPEC_DT * fs), s0 = ctr - half;
      let ok = true, mean = 0;
      for (let i = 0; i < N; i++) { const v = x[s0 + i]; if (!Number.isFinite(v)) { ok = false; break; } mean += v; }
      if (!ok || s0 < 0 || s0 + N > x.length) { bad.push(f); db.fill(NaN, f * SPEC_BINS, (f + 1) * SPEC_BINS); continue; }
      mean /= N;
      for (let i = 0; i < N; i++) { re[i] = (x[s0 + i] - mean) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k <= half; k++) psd[k] = ((re[k] * re[k] + im[k] * im[k]) / (fs * wss)) * (k > 0 && k < half ? 2 : 1);
      for (let b = 0; b < SPEC_BINS; b++) {
        if (edges[b] >= fs / 2) { db[f * SPEC_BINS + b] = NaN; continue; }   // above Nyquist (a station below 100 Hz): empty
        const k0 = Math.ceil(edges[b] / df), k1 = Math.floor(edges[b + 1] / df);
        let p = 0, n = 0;
        for (let k = k0; k <= k1 && k <= half; k++) { p += psd[k]; n++; }
        if (!n) { const fc = Math.sqrt(edges[b] * edges[b + 1]) / df, k = Math.min(half - 1, Math.floor(fc)), w = fc - k; p = psd[k] * (1 - w) + psd[k + 1] * w; n = 1; }
        db[f * SPEC_BINS + b] = 10 * Math.log10(Math.max(1e-20, p / n));
      }
    }
    if (range.lo == null) {                                  // the channel's range, fixed by its first hour
      const v = Array.from(db).filter(Number.isFinite).sort((a, b) => a - b);
      if (v.length) { range.lo = v[Math.floor(v.length * 0.02)]; range.hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.998))]; }
    }
    const lo = range.lo ?? 0, hi = range.hi ?? 1, bytes = new Uint8Array(db.length);
    for (let i = 0; i < db.length; i++) bytes[i] = Number.isFinite(db[i]) ? Math.max(0, Math.min(255, Math.round(((db[i] - lo) / Math.max(1e-9, hi - lo)) * 255))) : 0;
    return { meta: { chan: c.chan, t0: c.t0 + SPEC_DT / 2, dt: SPEC_DT, n_frames: nf, f_lo: SPEC_FLO, f_hi: SPEC_FHI, n_bins: SPEC_BINS, log_f: true, db_lo: lo, db_hi: hi,
                     win_s: N / fs, layout: "frames x bins, row-major, uint8", computed: "in the page, from the wave (spec_files false)", invalid_frames: bad }, bytes };
  }

  // ------------------------------------------------------------------------------------------------ StaticSource
  class StaticSource {
    constructor(root, manifest, io) {
      this.dataRoot = root;
      this.io = io || urlReader(root);     // O1: every file goes through one reader (published URL, a folder, a server, merged)
      this._m = manifest;
      this.isMock = !!manifest.mock;
      this.kind = "static";
      this._tile = new Map();       // "tier/source/idx" → Promise<tile|null>
      this._wave = new Map();       // "chan/YYYY-MM-DD/HH" → Promise<chunk|null>
      this._spec = new Map();
      this._subs = new Set();
      this._ev = null;              // columnar events, sorted by t
      this._replay = null;          // {tStart, speed, wall0}
      this._liveExtra = { events: [] };
    }
    manifest() { return this._m; }

    // ----- the clock: archive → t_end; replay-as-live → the replay clock
    now() {
      const r = this._replay;
      if (!r) return this._m.t_end;
      return Math.min(this._m.t_end, r.tStart + ((performance.now() - r.wall0) / 1000) * r.speed);
    }
    replayStart(tStart, speed) {
      this._replay = { tStart, speed, wall0: performance.now(), lastEmit: tStart };
      this._emit({ type: "clock", now: this.now(), mode: "replay_live" });
    }
    replayStop() { this._replay = null; this._emit({ type: "clock", now: this.now(), mode: "archive" }); }
    get replaying() { return !!this._replay; }
    get _clip() { return !!this._replay || this.kind === "live"; }
    // called by the page each frame: emits the events the replay clock has just passed (as a live feed would push them)
    pump() {
      const r = this._replay;
      if (!r || !this._ev) return;
      const now = this.now();
      if (now <= r.lastEmit) return;
      const E = this._ev, a = lowerBound(E.t, r.lastEmit), b = lowerBound(E.t, now);
      r.lastEmit = now;
      if (b > a) this._emit({ type: "events", rows: { i0: a, i1: b }, now });
      this._emit({ type: "clock", now, mode: "replay_live" });
    }
    subscribe(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
    _emit(msg) { for (const cb of this._subs) { try { cb(msg); } catch (e) { console.warn("[source] subscriber", e); } } }

    // ----- what exists
    station(id) { return (this._m.stations || []).find((s) => s.id === id) || null; }
    coverage(source) {
      if (source === "eq" || source === "gnss") return [[this._m.t0, this._m.t_end]];
      const s = this.station(source);
      return (s && s.coverage) || [];
    }
    covered(source, t0, t1) { return this.coverage(source).some(([a, b]) => b > t0 && a < t1); }
    // ----- the window rule (W1 §15.1, manifest.windows): the finest tiers (window_tiers: f10s, f1m) and the raw wave ship
    // only around each timeline event; outside, they are ABSENT BY DESIGN (absent_means), never silence: read the finest
    // full-record tier (f10m) there, or the researcher's folder or server (?data=…, O1). null = no window rule (all ships)
    windows() { const w = this._m.windows; return w && Array.isArray(w.spans) ? w : null; }
    inWindow(t0, t1) { const w = this.windows(); return !w || w.spans.some(([a, b]) => b > t0 && a < t1); }
    // the parts of [t0, t1) outside every window span
    outsideWindows(t0, t1) {
      const w = this.windows(); if (!w) return [];
      const out = []; let cur = t0;
      for (const [a, b] of [...w.spans].sort((p, q) => p[0] - q[0])) { if (b <= cur || a >= t1) continue; if (a > cur) out.push([cur, a]); cur = Math.max(cur, b); }
      if (cur < t1) out.push([cur, t1]);
      return out;
    }
    // the finest full-record tier this station has tiles for (f10m before f1h before f1d), or null
    baseTier(source) {
      const w = this.windows(); if (!w) return null;
      const tiers = (w.full_record_tiers || ["f10m", "f1h", "f1d"]).slice().sort((a, b) => (this._m.tiers[a] || {}).step - (this._m.tiers[b] || {}).step);
      return tiers.find((tr) => this._m.tiers[tr] && this._tileExists(tr, source)) || null;
    }
    _tileListed(tier, source, idx) {
      const T = this._m.tiles;                       // W1's index {tier: {source: [indices]}} wins when present
      if (T) return !!(T[tier] && T[tier][source] && T[tier][source].includes(idx));
      const s = this.station(source);
      if (s && s.tiles && s.tiles[tier]) return s.tiles[tier].includes(idx);
      const tr = this._m.tiers[tier];
      if (!tr) return false;
      if (tr.tile_rows == null) return idx === 0;
      const span = tr.step * tr.tile_rows;
      return this.covered(source, this._m.t0 + idx * span, this._m.t0 + (idx + 1) * span);
    }
    _tileExists(tier, source) {
      // eq has f1d/f1h/f10m in the mock; gnss only f1d. A manifest may list them; else assume the contract's tiers.
      const m = this._m;
      if (m.tiles) return !!(m.tiles[tier] && m.tiles[tier][source]);
      if (m.tile_sources && m.tile_sources[tier]) return m.tile_sources[tier].includes(source);
      if (source === "gnss") return tier === "f1d";
      if (source === "eq") return ["f1d", "f1h", "f10m"].includes(tier);
      return !!this.station(source);
    }
    _fetchTile(tier, source, idx, rel) {
      const key = rel || `tiles/${tier}/${source}/${idx}`;
      if (!this._tile.has(key)) {
        this._tile.set(key, this.io.json(`${key}.json`).catch((e) => { console.info("[source] tile absent", key); return null; }));
      }
      return this._tile.get(key);
    }

    // ----- tiles(tier, source, t0, t1) → {t:Float64Array, cols:{name:Array}, step, tier, source}, rows inside [t0, t1)
    async tiles(tier, source, t0, t1) {
      const tr = this._m.tiers[tier];
      const out = { tier, source, step: tr ? tr.step : null, t: new Float64Array(0), cols: {} };
      if (!tr || !this._tileExists(tier, source)) return out;
      const r = await this._rows(out, tier, t0, t1, (k) => this._tileListed(tier, source, k), (k) => `tiles/${tier}/${source}/${k}`);
      return this._lean && this._lean.tiers.has(tier) && source === this._lean.sta ? this._lean.keep(r) : r;
    }
    // a wave hour the manifest lists (the window rule: only inside the windows for a continuous station)
    waveListed(chan, t) { return this._chunkListed(chan, Math.floor(t / HOUR) * HOUR); }
    // dev only (?lean=1): W1's window rule applied to MELH's own day, to try the lean layout before any continuous station
    // exists: f10s / f1m rows and the HHZ wave hours only inside manifest.windows.spans, no spectrogram files (computed here)
    _leanFixture() {
      const m = this._m, W = this.windows(), sta = (m.stations || []).find((st) => st.kind === "seismic");
      if (!W || !sta) return;
      const inW = (a, b) => W.spans.some(([p, q]) => q > a && p < b), raw = (W.raw && W.raw.channels) || ["HHZ"];
      for (const [chan, v] of Object.entries(m.wave || {})) if (chan.startsWith(sta.id))
        v.hours = raw.includes(chan.split(".")[3]) ? (v.hours || []).filter((h) => { const t = Date.parse(h.replace("/", "T") + ":00:00Z") / 1000; return inW(t, t + HOUR); }) : [];
      for (const [chan, v] of Object.entries(m.spec || {})) if (chan.startsWith(sta.id)) v.hours = [];
      W.raw = { ...(W.raw || {}), spec_files: false };
      const tiers = new Set(W.window_tiers || ["f10s", "f1m"]);
      this._lean = { sta: sta.id, tiers, keep: (r) => {
        const idx = []; for (let i = 0; i < r.t.length; i++) if (inW(r.t[i], r.t[i] + (r.step || 1))) idx.push(i);
        const cols = {}; for (const [k, a] of Object.entries(r.cols)) cols[k] = idx.map((i) => a[i]);
        return { ...r, t: Float64Array.from(idx, (i) => r.t[i]), cols };
      } };
      m._fixture = (m._fixture ? m._fixture + " + " : "") + "lean (W1's window rule applied to MELH's day)";
    }
    // ----- body v2 (CONTRACT v0.11 §9): per-point tables viz/data/body/<kind>/<tier>/<tile>.json (same tiling as §4.2)
    // and room identities viz/data/body/identity/<kind>_<id>.json. Requests stay inside the manifest's body index when it
    // has one ({tiles:{kind:{tier:[…]}}, identities:[…]}); otherwise inside the data's coverage
    async bodyRows(kind, tier, t0, t1) {
      const tr = this._m.tiers[tier], B = this._m.body || {};
      const out = { tier, source: `body/${kind}`, kind, step: tr ? tr.step : null, t: new Float64Array(0), cols: {} };
      if (!tr || !this._m.body) return out;                  // no body section in the manifest = no Body v2 data yet: ask for nothing
      const listed = (k) => {
        const T = B.tables && B.tables[kind];                  // W1's index: tables.<kind> = {tier, tiles:[…]}
        if (B.tables) return !!T && T.tier === tier && (T.tiles || []).includes(k);
        const L = B.tiles && B.tiles[kind] && B.tiles[kind][tier];
        if (L) return L.includes(k);
        if (B.tiles) return false;
        if (tr.tile_rows == null) return k === 0;
        const span = tr.step * tr.tile_rows, a = this._m.t0 + k * span;
        return kind === "regime" ? (this._m.stations || []).some((st) => st.kind === "seismic" && this.covered(st.id, a, a + span)) : true;
      };
      return this._rows(out, tier, t0, t1, listed, (k) => `body/${kind}/${tier}/${k}`);
    }
    bodyIdentity(kind, id) {
      const B = this._m.body, name = `${kind}_${id}`;
      if (!B) return Promise.resolve(null);
      // W1's index: identity = [{kind, id, file, label, t0, t1, comb_hz, …}]
      const entry = Array.isArray(B.identity) ? B.identity.find((e) => e.kind === kind && +e.id === +id) : null;
      if (Array.isArray(B.identity) && !entry) return Promise.resolve(null);
      // a plain list of names, with or without ".json" (W1 ships both forms), is only consulted without the entries
      if (!entry && Array.isArray(B.identities) && !B.identities.some((n) => n === name || n === `${name}.json`)) return Promise.resolve(null);
      if (!this._ident) this._ident = new Map();
      const file = (entry && entry.file) || `body/identity/${name}.json`;
      // a failed read (a 404 while W1 re-exports) is not remembered, so the next ask tries again
      if (!this._ident.has(name)) this._ident.set(name, this.io.json(file).then((j) => ({ ...j, label: j.label ?? (entry && entry.label) }))
        .catch(() => { this._ident.delete(name); return null; }));
      return this._ident.get(name);
    }
    async _rows(out, tier, t0, t1, listed, rel) {
      const tr = this._m.tiers[tier];
      const lim = this._clip ? Math.min(t1, this.now()) : t1;
      const lo = Math.max(t0, this._m.t0), hi = Math.min(lim, this._m.t_end);
      if (hi <= lo) return out;
      let idxs;
      if (tr.tile_rows == null) idxs = [0];
      else {
        const span = tr.step * tr.tile_rows;
        const a = Math.floor((lo - this._m.t0) / span), b = Math.floor((hi - 1e-6 - this._m.t0) / span);
        idxs = [];
        for (let k = a; k <= b; k++) if (listed(k)) idxs.push(k);
        if (idxs.length > 400) idxs = idxs.slice(0, 400);      // a guard, never reached at the level each tier serves
      }
      if (tr.tile_rows == null && !listed(0)) idxs = [];
      const tiles = (await Promise.all(idxs.map((k) => this._fetchTile(tier, null, k, rel(k))))).filter(Boolean);
      const ts = [], cols = {};
      for (const tl of tiles) {
        const i0 = Math.max(0, Math.floor((lo - tl.t0) / tl.step)), i1 = Math.min(tl.n, Math.ceil((hi - tl.t0) / tl.step));
        for (const c of tl.cols) if (!cols[c]) cols[c] = [];
        for (let i = i0; i < i1; i++) {
          ts.push(tl.t0 + i * tl.step);
          for (const c of tl.cols) cols[c].push(tl.data[c][i]);
        }
      }
      out.t = Float64Array.from(ts);
      out.cols = cols;
      return out;
    }

    // ----- events: all rows are loaded once (CONTRACT §4.2: 34,102 rows, columnar)
    async loadEvents() {
      if (this._ev) return this._ev;
      const j = await this.io.json((this._m.events && this._m.events.file) || "events/eq.json");
      const d = j.data || j, n = (d.t || []).length;
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d.t[a] - d.t[b]);
      const pick = (c, F) => { const a = F ? new F(n) : new Array(n); for (let k = 0; k < n; k++) { const v = d[c] ? d[c][order[k]] : null; a[k] = F ? (v == null ? NaN : v) : v; } return a; };
      this._ev = { n, t: pick("t", Float64Array), mag: pick("mag", Float32Array), depth_km: pick("depth_km", Float32Array),
                   lat: pick("lat", Float32Array), lon: pick("lon", Float32Array), fc_hz: pick("fc_hz", Float32Array), id: pick("id") };
      return this._ev;
    }
    // ----- v0.13: the eruption timeline (events/eruptions.json) and its fountain series (events/fountains/<id>.json).
    // The list is read only when the manifest declares it (manifest.eruptions = {file} or an inline row array), so a
    // manifest without it asks for nothing. The rows land on the manifest as M._eruptions (cook.eruptionList reads them).
    // ?fixture=<dir> (dev only): rows and station positions from viz/dev_mock/<dir>/, never viz/data.
    async loadEruptions() {
      const m = this._m, fx = new URLSearchParams(location.search).get("fixture"), dec = m.eruptions || m.events_eruptions || (m.events && m.events.eruptions);
      const fxRoot = fx && /^[\w-]+$/.test(fx) ? `dev_mock/${fx}/` : null;
      let rows = null;
      if (fxRoot) {
        rows = await getJSON(`${fxRoot}eruptions.json`).catch(() => null);
        const st = await getJSON(`${fxRoot}stations.json`).catch(() => null);      // stand-in positions, to test the drawing
        if (st) for (const s of m.stations || []) { const o = (st.stations || st).find((x) => x.id === s.id); if (o) Object.assign(s, o); }
        m._fixture = fx;
      } else if (Array.isArray(dec)) rows = dec;
      else if (dec && dec.file) rows = await this.io.json(dec.file).catch((e) => { console.info("[source] eruptions absent", e.message); return null; });
      m._eruptionsCmp = (rows && !Array.isArray(rows) && rows.comparison) || null;   // W1's own matched / missed / false_alarms
      rows = rows && (rows.rows || rows.eruptions || rows.data || rows);
      m._eruptions = Array.isArray(rows) ? rows : null;
      return m._eruptions;
    }
    // one eruption's fountain series: only a file the manifest's fountains index names (ref = that entry, {id, file, …};
    // cook.eruptionList hands it over as e.fnt), never a guessed path, so never a 404
    fountains(ref) {
      if (!ref || !ref.file) return Promise.resolve(null);
      this._fnt = this._fnt || new Map();
      const url = ref.file;
      if (!this._fnt.has(url)) this._fnt.set(url, this.io.json(url).catch(() => null));
      return this._fnt.get(url);
    }
    // events(t0, t1) → {i0, i1, ...columns} (index range into the sorted columns; nothing is copied)
    events(t0, t1) {
      const E = this._ev;
      if (!E) return { i0: 0, i1: 0, n: 0 };
      const lim = this._clip ? Math.min(t1, this.now()) : t1;
      const i0 = lowerBound(E.t, t0), i1 = Math.max(i0, lowerBound(E.t, lim));
      return { i0, i1, n: i1 - i0, t: E.t, mag: E.mag, depth_km: E.depth_km, lat: E.lat, lon: E.lon, fc_hz: E.fc_hz, id: E.id };
    }

    // ----- waves: one-hour u16 chunks + sidecar (CONTRACT §4.2)
    _hours(kind, chan) {                            // W1: manifest.wave / manifest.spec = {chan: {hours: ["YYYY-MM-DD/HH", …]}}
      const idx = this._m[kind];
      if (idx && idx[chan]) return idx[chan].hours || [];
      if (idx) return [];
      return null;
    }
    _chunkListed(chan, t, kind = "wave") {
      const hrs = this._hours(kind, chan);
      if (hrs) return hrs.includes(`${ymd(t)}/${hh(t)}`);
      const sta = chan.split(".").slice(0, 3).join("."), s = this.station(sta);
      if (s && s.wave && s.wave[chan]) return s.wave[chan].includes(`${ymd(t)}/${hh(t)}`);
      if (!s || !(s.channels || []).includes(chan.split(".")[3])) return false;
      return this.covered(sta, Math.floor(t / HOUR) * HOUR, Math.floor(t / HOUR) * HOUR + HOUR);
    }
    hasWave(chan) {
      const hrs = this._hours("wave", chan);
      if (hrs) return hrs.length > 0;
      const sta = chan.split(".").slice(0, 3).join("."), s = this.station(sta);
      if (!s) return false;
      if (s.wave) return !!(s.wave[chan] && s.wave[chan].length);
      return (s.channels || []).includes(chan.split(".")[3]);
    }
    _chunk(chan, t) {
      const h = Math.floor(t / HOUR) * HOUR, key = `${chan}/${ymd(h)}/${hh(h)}`;
      if (!this._wave.has(key)) {
        if (!this._chunkListed(chan, h)) { this._wave.set(key, Promise.resolve(null)); return this._wave.get(key); }
        const base = `wave/${chan}/${ymd(h)}/${hh(h)}`;
        this._wave.set(key, Promise.all([this.io.json(base + ".json"), this.io.bytes(base + ".u16")]).then(([meta, buf]) => {
          const u = new Uint16Array(buf), x = new Float32Array(u.length), sc = meta.scale;
          for (let i = 0; i < u.length; i++) x[i] = (u[i] / 32767.5 - 1) * sc;
          const gapMask = new Uint8Array(u.length);
          for (const [a, b] of meta.gaps || []) gapMask.fill(1, a, b);
          for (let i = 0; i < u.length; i++) if (gapMask[i]) x[i] = NaN;
          // a min/max pyramid at 1 s blocks, so a 3-hour waveform draws without touching 1M samples
          const B = Math.max(1, Math.round(meta.fs)), nb = Math.ceil(x.length / B), mn = new Float32Array(nb), mx = new Float32Array(nb);
          for (let k = 0; k < nb; k++) {
            let lo = Infinity, hi = -Infinity;
            for (let i = k * B, e = Math.min(x.length, i + B); i < e; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
            mn[k] = lo === Infinity ? NaN : lo; mx[k] = hi === -Infinity ? NaN : hi;
          }
          return { ...meta, x, block: B, mn, mx };
        }).catch(() => null));
      }
      return this._wave.get(key);
    }
    // wave(chan, t0, n) → {data: Float32Array(n), t0, fs, gaps:[[i0,i1]...]}: NaN-free (gaps are zeros, and listed)
    async wave(chan, t0, n) {
      const first = await this._firstChunk(chan, t0);
      const fs = first ? first.fs : 100;
      const out = new Float32Array(n), gaps = [];
      let filled = 0, t = t0, gapStart = -1;
      const lim = this._clip ? this.now() : Infinity;
      while (filled < n) {
        const c = await this._chunk(chan, t);
        const chunkEnd = Math.floor(t / HOUR) * HOUR + HOUR;
        const take = Math.min(n - filled, Math.max(1, Math.round((chunkEnd - t) * fs)));
        for (let k = 0; k < take; k++) {
          const tk = t + k / fs;
          let v = NaN;
          if (c && tk <= lim) { const i = Math.round((tk - c.t0) * c.fs); if (i >= 0 && i < c.x.length) v = c.x[i]; }
          const idx = filled + k;
          if (Number.isFinite(v)) { out[idx] = v; if (gapStart >= 0) { gaps.push([gapStart, idx]); gapStart = -1; } }
          else { out[idx] = 0; if (gapStart < 0) gapStart = idx; }
        }
        filled += take; t += take / fs;
      }
      if (gapStart >= 0) gaps.push([gapStart, n]);
      return { data: out, t0, fs, gaps };
    }
    async _firstChunk(chan, t) { return this._chunk(chan, t); }
    // waveSpan(chan, t0, t1) → the loaded chunks overlapping [t0, t1) (for drawing; the page reads x / mn / mx itself)
    async waveSpan(chan, t0, t1) {
      if (!this.hasWave(chan)) return [];
      const out = [];
      for (let h = Math.floor(t0 / HOUR) * HOUR; h < t1; h += HOUR) {
        if (out.length > 30) break;
        const c = await this._chunk(chan, h);
        if (c) out.push(c);
      }
      return out;
    }
    // spec(chan, t0, t1) → hourly spectrogram tiles [{meta, bytes:Uint8Array}] (CONTRACT §4.2, frames × bins)
    async spec(chan, t0, t1) {
      const sta = chan.split(".").slice(0, 3).join("."), s = this.station(sta);
      const cha = chan.split(".")[3];
      const hrs = this._hours("spec", chan);
      // W1 §15.1: a continuous station ships no spectrogram files (windows.raw.spec_files false); the page computes them
      // from the wave hours it has. MELH keeps its files
      // …and any tree that ships wave hours but no spectrogram files for a channel (a researcher's tree exported without them)
      const W = this.windows(), noFiles = !hrs || !hrs.length;
      const compute = !!(noFiles && this.hasWave(chan) && (W ? W.raw && W.raw.spec_files === false : !(this._m.spec && this._m.spec[chan])));
      if (compute) {
        const out = [];
        for (let h = Math.floor(t0 / HOUR) * HOUR; h < t1 && out.length <= 30; h += HOUR) {
          if (!this._chunkListed(chan, h, "wave")) continue;
          const key = `${chan}/${ymd(h)}/${hh(h)}#page`;
          if (!this._spec.has(key)) this._spec.set(key, this._chunk(chan, h).then((c) => (c ? specFromWave(c, this._specRange(chan)) : null)).catch(() => null));
          const v = await this._spec.get(key);
          if (v) out.push(v);
        }
        return out;
      }
      if (!hrs && (!s || (s.spec && !s.spec.includes(cha)))) return [];
      const out = [];
      for (let h = Math.floor(t0 / HOUR) * HOUR; h < t1 && out.length <= 30; h += HOUR) {
        if (!this._chunkListed(chan, h, hrs ? "spec" : "wave")) continue;
        const key = `${chan}/${ymd(h)}/${hh(h)}`;
        if (!this._spec.has(key)) {
          const base = `spec/${chan}/${ymd(h)}/${hh(h)}`;
          this._spec.set(key, Promise.all([this.io.json(base + ".json"), this.io.bytes(base + ".u8")])
            .then(([meta, buf]) => ({ meta, bytes: new Uint8Array(buf) })).catch(() => null));
        }
        const v = await this._spec.get(key);
        if (v) out.push(v);
      }
      return out;
    }
    // the dB range a computed spectrogram is scaled to, one per channel so hours match: the manifest's (ranges["spec:<chan>"])
    // when it says, else fixed by the first hour computed (its p2 … p99.8)
    _specRange(chan) {
      const r = (this._m.ranges || {})[`spec:${chan}`];
      if (r && isFinite(r.lo) && isFinite(r.hi)) return r;
      this._specR = this._specR || {};
      return this._specR[chan] || (this._specR[chan] = { lo: null, hi: null });
    }
    async latent(station) {
      const L = this._m.latent;
      if (L && !L[station]) return null;
      const file = (L && L[station] && L[station].file) || `latent/${station}_f1m.json`;
      try { return await this.io.json(file); } catch (_) { return null; }
    }
    // the Ground ring's absolute scale: the record's peak |x| for this channel. From the manifest when it says
    // (ranges["wave:<chan>"] or wave[chan].peak); otherwise the max of the listed hours' sidecar scales (fetched once)
    async waveNorm(chan) {
      const r = (this._m.ranges || {})[`wave:${chan}`], w = (this._m.wave || {})[chan];
      if (r && r.max > 0) return { norm: r.max, how: "manifest ranges" };
      if (w && w.peak > 0) return { norm: w.peak, how: "manifest wave index" };
      if (!this._norm) this._norm = {};
      if (!this._norm[chan]) {
        const hrs = this._hours("wave", chan) || [];
        this._norm[chan] = Promise.all(hrs.map((h) => this.io.json(`wave/${chan}/${h}.json`).catch(() => null)))
          .then((ms) => ({ norm: Math.max(1e-9, ...ms.filter(Boolean).map((m) => m.scale || 0)), how: `max of ${hrs.length} hourly sidecar scales (the manifest has no peak yet)` }));
      }
      return this._norm[chan];
    }
  }

  // ------------------------------------------------------------------------------------------------ LiveSource
  // Backfill from static + WS push from pipeline/live_server.py (CONTRACT §6 "Live push"). A working slot: it merges
  // {type:"frames", tier, source, rows, partial}, {type:"wave", chan, t0, fs, scale, data_b64_u16} and
  // {type:"events", rows} into the caches the StaticSource reads, and moves now() to the newest time it has seen.
  class LiveSource extends StaticSource {
    constructor(root, manifest, url, io) {
      super(root, manifest, io);
      this.kind = "live";
      this.url = url;
      this._live = { now: manifest.t_end, seen: false, frames: new Map(), waves: new Map() };
      this.status = "connecting";
      this._connect();
    }
    // the newest time the feed has delivered (a replay-as-live server's clock is in the past: that is fine)
    now() { return this._live.seen ? this._live.now : this._m.t_end; }
    // the sources panel's disconnect: no more retries
    close() { this._closed = true; try { this._ws && this._ws.close(); } catch (_) {} }
    _connect() {
      if (this._closed) return;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this.status = "failed"; return; }
      this._ws = ws;
      ws.onopen = () => { this.status = "open"; this._retry = 0; this._emit({ type: "status", status: "open" }); };
      // a feed that is down is retried with backoff (3 s … 60 s), so a dead feed does not flood the console
      ws.onclose = () => { this.status = this._closed ? "disconnected" : "closed"; this._emit({ type: "status", status: this.status }); if (this._closed) return;
        this._retry = (this._retry || 0) + 1; setTimeout(() => this._connect(), Math.min(60000, 3000 * 2 ** (this._retry - 1))); };
      ws.onerror = () => {};
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        this._ingest(m);
        this._emit(m);
      };
    }
    _ingest(m) {
      if (m.type === "hello") { if (Number.isFinite(m.t_now)) { this._live.now = m.t_now; this._live.seen = true; } this.hello = m; return; }
      if (m.type === "frames" || m.type === "events" || m.type === "wave") this._live.seen = true;
      if (m.type === "frames" && Array.isArray(m.rows)) {
        const key = `${m.tier}/${m.source}`;
        if (!this._live.frames.has(key)) this._live.frames.set(key, new Map());
        const store = this._live.frames.get(key);
        for (const r of m.rows) { store.set(r.t, { ...r, partial: !!m.partial }); this._live.now = Math.max(this._live.now, r.t); }
      } else if (m.type === "events" && Array.isArray(m.rows) && this._ev) {
        // append to the sorted columns (live rows arrive in time order; anything older is inserted)
        for (const r of m.rows) this._appendEvent(r);
      } else if (m.type === "wave" && m.data_b64_u16) {
        const bin = atob(m.data_b64_u16), u = new Uint16Array(bin.length / 2);
        for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        const x = new Float32Array(u.length);
        for (let i = 0; i < u.length; i++) x[i] = (u[i] / 32767.5 - 1) * m.scale;
        if (!this._live.waves.has(m.chan)) this._live.waves.set(m.chan, []);
        this._live.waves.get(m.chan).push({ t0: m.t0, fs: m.fs, x });
        this._live.now = Math.max(this._live.now, m.t0 + u.length / m.fs);
      }
    }
    _appendEvent(r) {
      const E = this._ev, n = E.n + 1, i = lowerBound(E.t, r.t);
      const grow = (a, v, F) => { const b = F ? new F(n) : new Array(n); b.set ? (b.set(a.subarray(0, i), 0), b.set(a.subarray(i), i + 1)) : (a.slice(0, i).forEach((x, k) => (b[k] = x)), a.slice(i).forEach((x, k) => (b[i + 1 + k] = x))); b[i] = v; return b; };
      E.t = grow(E.t, r.t, Float64Array); E.mag = grow(E.mag, r.mag ?? NaN, Float32Array); E.depth_km = grow(E.depth_km, r.depth_km ?? NaN, Float32Array);
      E.lat = grow(E.lat, r.lat ?? NaN, Float32Array); E.lon = grow(E.lon, r.lon ?? NaN, Float32Array); E.fc_hz = grow(E.fc_hz, r.fc_hz ?? NaN, Float32Array);
      E.id = grow(E.id, r.id ?? "", null); E.n = n;
      this._live.now = Math.max(this._live.now, r.t);
    }
    _chunk(chan, t) {
      const pieces = this._live.waves.get(chan);
      if (!pieces || !pieces.length) return super._chunk(chan, t);
      return super._chunk(chan, t).then((c) => c || this._liveChunk(chan, Math.floor(t / HOUR) * HOUR));
    }
    _liveChunk(chan, h) {
      const ps = (this._live.waves.get(chan) || []).filter((p) => p.t0 < h + HOUR && p.t0 + p.x.length / p.fs > h);
      if (!ps.length) return null;
      const fs = ps[0].fs, x = new Float32Array(Math.round(HOUR * fs)).fill(NaN);
      for (const p of ps) { const o = Math.round((p.t0 - h) * fs); for (let i = 0; i < p.x.length; i++) if (o + i >= 0 && o + i < x.length) x[o + i] = p.x[i]; }
      const B = Math.max(1, Math.round(fs)), nb = Math.ceil(x.length / B), mn = new Float32Array(nb), mx = new Float32Array(nb);
      for (let k = 0; k < nb; k++) { let lo = Infinity, hi = -Infinity; for (let i = k * B; i < Math.min(x.length, (k + 1) * B); i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; } mn[k] = lo === Infinity ? NaN : lo; mx[k] = hi === -Infinity ? NaN : hi; }
      return { chan, t0: h, fs, n: x.length, x, block: B, mn, mx, live: true };
    }
    hasWave(chan) { return super.hasWave(chan) || (this._live.waves.get(chan) || []).length > 0; }
    async tiles(tier, source, t0, t1) {
      const out = await super.tiles(tier, source, t0, t1);
      const store = this._live.frames.get(`${tier}/${source}`);
      if (!store || !store.size) return out;
      const ts = Array.from(out.t), cols = out.cols, have = new Set(ts);
      for (const [t, r] of [...store.entries()].sort((a, b) => a[0] - b[0])) {
        if (t < t0 || t >= t1 || have.has(t)) continue;
        ts.push(t);
        for (const c of Object.keys(r)) { if (c === "t") continue; if (!cols[c]) cols[c] = new Array(ts.length - 1).fill(null); }
        for (const c of Object.keys(cols)) cols[c].push(r[c] ?? null);
      }
      out.t = Float64Array.from(ts);
      return out;
    }
  }

  // ------------------------------------------------------------------------------------------------ MergedSource (O1)
  // a loaded tree laid over the published data (CONTRACT §7; DESIGN §6.1): by station and tier, the loaded tree wins where
  // it has data and the published one fills the rest. Each tree is read on its own tile grid (a tree's t0 is its own), so
  // rows are merged by time, raw hours by the clock; what neither has follows the published windows rule (absent_means)
  class MergedSource extends StaticSource {
    constructor(P, L, tree) {
      super(P.dataRoot, mergeManifests(P.manifest(), L.manifest(), tree.label), P.io);
      this.P = P; this.L = L; this.tree = tree; this._lean = null;
      this.loaded = { kind: tree.kind, via: (tree.io && tree.io.via) || (tree.raw ? "raw" : null), raw: !!tree.raw, layout: tree.layout || null, label: tree.label, name: tree.name, built: tree.manifest.built || null, contract: tree.manifest.contract || null,
                      plain: tree.plain, public: tree.public, stations: (tree.manifest.stations || []).map((s) => s.id), handle: (tree.io && tree.io.handle) || tree.handle || null,
                      channels: tree.chans ? [...tree.chans.keys()] : null, skipped: tree.skipped || 0, rawBeside: tree.rawPart ? tree.rawPart.chans.size : 0, rates: tree.rates || null, tableFs: TABLE_FS.slice(),
                      // a tile tree's own word on bands its stations' rates lack (W1's manifest.stations[].bands.note, 0.16)
                      bandNotes: tree.raw ? [] : (tree.manifest.stations || []).filter((s) => s.bands && s.bands.note).map((s) => ({ sta: s.id.split(".")[1] || s.id, note: s.bands.note })),
                      check: tree.check ? { sizes: tree.check.sizes, warn: tree.check.warn, files: tree.check.indexed.size } : null };
    }
    _lHas(tier, source) { if (this.L.computes) return this.L.computes(tier, source); const T = this.L._m.tiles; return !!(T && T[tier] && T[tier][source] && T[tier][source].length); }
    async tiles(tier, source, t0, t1) {
      const [p, l] = await Promise.all([this.P.tiles(tier, source, t0, t1), this._lHas(tier, source) ? this.L.tiles(tier, source, t0, t1) : null]);
      if (!l || !l.t.length) return p;
      if (!p.t.length) return l;
      const computed = !!l.computed;                           // computed in this browser from raw data (O1 step 3)
      // a published row stays only where the loaded tree has no row within half a step of it
      const step = l.step || p.step || 1, keepP = [];
      for (let i = 0; i < p.t.length; i++) { const j = lowerBound(l.t, p.t[i] - step / 2); if (!(j < l.t.length && Math.abs(l.t[j] - p.t[i]) < step / 2)) keepP.push(i); }
      if (!keepP.length) return l;
      const rows = [...Array.from(l.t, (t, i) => [t, 0, i]), ...keepP.map((i) => [p.t[i], 1, i])].sort((a, b) => a[0] - b[0]);
      const names = [...new Set([...Object.keys(l.cols), ...Object.keys(p.cols)])], cols = {};
      for (const c of names) cols[c] = rows.map(([, w, i]) => { const a = (w ? p : l).cols[c]; return a ? a[i] : null; });
      return { tier, source, step, t: Float64Array.from(rows, (r) => r[0]), cols, computed };
    }
    // the raw hours: the loaded tree's where it lists the hour, else the published
    _chunkListed(chan, t, kind = "wave") { return this.L._chunkListed(chan, t, kind) || this.P._chunkListed(chan, t, kind); }
    hasWave(chan) { return this.L.hasWave(chan) || this.P.hasWave(chan); }
    _chunk(chan, t) { const h = Math.floor(t / HOUR) * HOUR; return this.L._chunkListed(chan, h) ? this.L._chunk(chan, t) : this.P._chunk(chan, t); }
    async spec(chan, t0, t1) {
      const [l, p] = await Promise.all([this.L.spec(chan, t0, t1), this.P.spec(chan, t0, t1)]);
      const hours = new Set(l.map((x) => Math.floor(x.meta.t0 / HOUR)));
      return [...l, ...p.filter((x) => !hours.has(Math.floor(x.meta.t0 / HOUR)))].sort((a, b) => a.meta.t0 - b.meta.t0);
    }
    _specRange(chan) { return this.P._specRange(chan); }
    // what W1's trees do not carry stays the published data's: the catalogue, the eruptions, the body, the latent map
    async loadEvents() { const S = this.L._m.events ? this.L : this.P; await S.loadEvents(); this._ev = S._ev; return this._ev; }
    async loadEruptions() {
      const S = this.L._m.eruptions || this.L._m.events_eruptions ? this.L : this.P;
      if (S === this.L) await S.loadEruptions();
      this._m._eruptions = S._m._eruptions; this._m._eruptionsCmp = S._m._eruptionsCmp; this._m._fixture = this.P._m._fixture;
      this._eru = S; return this._m._eruptions;
    }
    fountains(ref) { return (this._eru || this.P).fountains(ref); }
    bodyRows(kind, tier, t0, t1) { return (this.L._m.body ? this.L : this.P).bodyRows(kind, tier, t0, t1); }
    bodyIdentity(kind, id) { return (this.L._m.body ? this.L : this.P).bodyIdentity(kind, id); }
    latent(station) { return (this.L._m.latent && this.L._m.latent[station] ? this.L : this.P).latent(station); }
    waveNorm(chan) { return ((this.P._m.wave || {})[chan] || (this.P._m.ranges || {})[`wave:${chan}`] ? this.P : this.L).waveNorm(chan); }
  }

  // the engine's tiers, the rates it has filter tables for, how much a fresh day warms up before it, how many days one
  // request computes at most (a wide view gets the days nearest its middle; zooming in computes the rest)
  const STEP = { f10s: 10, f1m: 60, f10m: 600, f1h: 3600, f1d: 86400 }, WARM_S = 600, MAX_DAYS = 10;
  let TABLE_FS = [];                                         // set by filterTables() from mseed/filters.json (20–250 Hz in 0.16)
  const ENGINE_V = "0.16";                                   // in the cache key: a day computed by an older port is computed again
  // a station's channel codes → the engine's roles (Z/N/E: the H?? channels first, else any broadband / short-period
  // seismometer; tZ/tN/tE: LM? mass position)
  function rolesFor(fl) {
    const codes = Object.keys(fl), pick = (re) => codes.find((c) => re.test(c));
    const r = { Z: pick(/^HHZ$/) || pick(/^[EHBS][HN]Z$/), N: pick(/^HHN$/) || pick(/^[EHBS][HN][N1]$/), E: pick(/^HHE$/) || pick(/^[EHBS][HN][E2]$/),
                tZ: pick(/^LMZ$/), tN: pick(/^LMN$/), tE: pick(/^LME$/) };
    return Object.fromEntries(Object.entries(r).filter(([, v]) => v));
  }
  // the computed days, per viewer (IndexedDB "svk_o1_feat"); every call wrapped: a private window just recomputes
  const featStore = (() => {
    const open = () => new Promise((res) => { try { const rq = indexedDB.open("svk_o1_feat", 1); rq.onupgradeneeded = () => { try { rq.result.createObjectStore("d"); } catch (_) {} }; rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); } catch (_) { res(null); } });
    let db = null;
    const tx = async (mode, fn) => { try { db = db || (await open()); if (!db) return null; return await new Promise((res) => { const t = db.transaction("d", mode), r = fn(t.objectStore("d")); t.oncomplete = () => res(r && "result" in r ? r.result : true); t.onerror = () => res(null); t.onabort = () => res(null); }); } catch (_) { return null; } };
    return { get: (k) => tx("readonly", (st) => st.get(k)), put: (k, v) => tx("readwrite", (st) => st.put(v, k)), clear: () => tx("readwrite", (st) => st.clear()) };
  })();

  // ------------------------------------------------------------------------------------------------ RawSource (O1 step 3)
  // raw miniSEED as a source: an hour of a channel is decoded by the worker when the view asks for it (never the whole
  // archive), laid on the hour's own grid (gaps NaN, listed) with the same 1-s min/max pyramid as a published wave hour.
  // So the waveforms, the Ground and the page's spectrograms work from raw data; the feature tiles come with the engine
  class RawSource extends StaticSource {
    constructor(manifest, chans) {
      super("", manifest, { kind: "raw", json: () => Promise.reject(new Error("a raw folder has no tile files")), bytes: () => Promise.reject(new Error("a raw folder has no tile files")), has: null });
      this.kind = "static"; this.chans = chans; this._peak = {}; this._mem = new Map(); this.onProgress = null;
    }
    _filesAt(chan, h) { return (this.chans.get(chan) || []).filter((m) => m.spanS[1] > h && m.spanS[0] < h + HOUR); }
    _chunkListed(chan, t, kind = "wave") { return kind === "wave" && this._filesAt(chan, Math.floor(t / HOUR) * HOUR).length > 0; }
    hasWave(chan) { return this.chans.has(chan); }
    // ----- the feature tiles, computed in the worker by the ported engine (O1 step 3), a UTC day at a time, as the view
    // asks: a day continues from the previous day's state when that is known (exact), else it starts 10 min early and
    // drops those warm-up rows. Kept per viewer (memory + IndexedDB), cancelled when the view moves on, its progress
    // reported in a few words (onProgress)
    _stationFiles(source) {
      const out = {};
      for (const [chan, fl] of this.chans) if (chan.startsWith(source + ".")) (out[chan.split(".")[3]] = out[chan.split(".")[3]] || []).push(...fl);
      return out;
    }
    computes(tier, source) {
      if (!STEP[tier]) return false;
      const fl = this._stationFiles(source), z = fl.HHZ || fl[Object.keys(fl).find((c) => /Z$/.test(c) && c[0] !== "L")];
      return !!z && TABLE_FS.includes(+z[0].fs);
    }
    async tiles(tier, source, t0, t1) {
      const empty = { tier, source, step: STEP[tier] || null, t: new Float64Array(0), cols: {} };
      if (!this.computes(tier, source)) return empty;
      const st = (this._m.stations || []).find((s) => s.id === source), cov = (st && st.coverage) || [];
      if (!cov.length) return empty;
      const a = Math.max(t0, cov[0][0]), b = Math.min(t1, cov[cov.length - 1][1]);
      if (!(b > a)) return empty;
      let days = []; for (let d = Math.floor(a / DAY) * DAY; d < b; d += DAY) if (cov.some(([p, q]) => q > d && p < d + DAY)) days.push(d);
      const capped = days.length > MAX_DAYS;
      if (capped) { const mid = (a + b) / 2; days = days.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid)).slice(0, MAX_DAYS).sort((x, y) => x - y); }
      await this._ensure(source, days, capped ? `${MAX_DAYS} of the ${Math.ceil((b - a) / DAY)} days in view` : null);
      const rows = [];
      for (const d of days) { const e = this._mem.get(`${source}|${d}`); if (e) for (const r of e.rows[tier] || []) if (r.t >= t0 && r.t < t1) rows.push(r); }
      rows.sort((x, y) => x.t - y.t);
      const cols = {}, names = rows.length ? Object.keys(rows[0]).filter((k) => k !== "t") : [];
      for (const c of names) cols[c] = rows.map((r) => (r[c] == null ? null : r[c]));
      return { tier, source, step: STEP[tier], t: Float64Array.from(rows, (r) => r.t), cols, computed: true };
    }
    // the raw data of [from, to) per channel: the files that hold it (a folder); an FDSN source fetches it (below)
    async _dayFiles(source, fl, from, to) {
      const files = {};
      for (const [cha, ms] of Object.entries(fl)) { const hit = ms.filter((m) => m.spanS[1] > from && m.spanS[0] < to).map((m) => m.blob); if (hit.length) files[cha] = hit; }
      return files;
    }
    _sig(source) {
      const fl = Object.values(this._stationFiles(source)).flat();
      return `engine ${ENGINE_V}|` + (this.fdsn ? this.fdsn.base + "|" : "") + fl.map((m) => (m.blob ? `${m.name}:${m.blob.size}:${m.blob.lastModified || 0}` : `${m.spanS.join("-")}:${m.fs}`)).sort().join("|");
    }
    async _ensure(source, days, note) {
      this._want = { source, days: new Set(days) };
      const gen = (this._gen = (this._gen || 0) + 1);
      if (this._running && !(this._running.source === source && this._want.days.has(this._running.day))) this._running.cancel();
      this._q = (this._q || Promise.resolve()).then(async () => {
        const todo = days.filter((d) => !this._mem.has(`${source}|${d}`));
        let k = 0, shown = false;
        for (const d of todo) {
          if (this._gen !== gen && !(this._want.source === source && this._want.days.has(d))) continue;   // the view moved on
          k++;
          if (await this._fromStore(source, d)) continue;
          await this._day(source, d, (f) => { shown = true; if (this.onProgress) this.onProgress({ source, day: d, frac: f, k, of: todo.length, note }); });
        }
        // "done" only when a day arrived (the view reloads to show it) or a progress line must go: the page answers it by
        // reloading the window, which asks again, so a "done" with nothing new looped every 60 ms
        if (this.onProgress && (shown || todo.some((d) => this._mem.has(`${source}|${d}`)))) this.onProgress(null);
      });
      return this._q;
    }
    async _day(source, d, onP) {
      const st = (this._m.stations || []).find((s) => s.id === source), start = st.coverage[0][0], end = st.coverage[st.coverage.length - 1][1];
      const prev = this._mem.get(`${source}|${d - DAY}`), state = prev && prev.state && prev.end === d ? prev.state : null;
      const from = state ? d : Math.max(start, d - WARM_S), to = Math.min(d + DAY, end + 1), final = to >= end;
      const fl = this._stationFiles(source), files = await this._dayFiles(source, fl, from, to);
      const run = wkFeatures({ station: source, roles: rolesFor(fl), files, from, to, keep: d, state, final }, onP);
      this._running = { source, day: d, cancel: run.cancel };
      let res;
      try { res = await run; } catch (e) {
        this._running = null; if (/cancelled/.test(e.message)) return;
        console.info("[source] features not computed", source, new Date(d * 1000).toISOString().slice(0, 10), e.message);
        this._mem.set(`${source}|${d}`, { rows: {}, state: null, end: to, failed: e.message });   // not retried until a reload
        return;
      }
      this._running = null;
      const entry = { rows: res.rows, state: final ? null : res.state, end: to, exact: !!state || from <= start, stats: res.stats, ms: res.ms };
      this._mem.set(`${source}|${d}`, entry);
      featStore.put(`${this._sig(source)}|${source}|${d}`, entry);
    }
    async _fromStore(source, d) {
      const e = await featStore.get(`${this._sig(source)}|${source}|${d}`);
      if (e && e.rows) { this._mem.set(`${source}|${d}`, e); return true; }
      return false;
    }
    _chunk(chan, t) {
      const h = Math.floor(t / HOUR) * HOUR, key = `${chan}/${ymd(h)}/${hh(h)}`;
      if (!this._wave.has(key)) {
        const files = this._filesAt(chan, h);
        if (!files.length) { this._wave.set(key, Promise.resolve(null)); return this._wave.get(key); }
        this._wave.set(key, wkRead(files, h, h + HOUR).then(({ segs }) => this._hour(chan, h, segs, files[0].fs))
          .catch((e) => { console.info("[source] raw hour not read", key, e.message); return null; }));
      }
      return this._wave.get(key);
    }
    // decoded segments → an hour on its own grid: NaN in the gaps (listed), the 1-s min/max pyramid, the peak so far
    _hour(chan, h, segs, fsFallback) {
      const fs = segs.length ? segs[0].fs : fsFallback, n = Math.round(HOUR * fs), x = new Float32Array(n).fill(NaN);
      let peak = 0;
      for (const sg of segs) {
        if (sg.fs !== fs) continue;
        const i0 = Math.round((sg.t0 - h) * fs);
        for (let i = 0; i < sg.data.length; i++) { const k = i0 + i; if (k < 0 || k >= n) continue; const v = sg.data[i]; x[k] = v; const a = Math.abs(v); if (a > peak) peak = a; }
      }
      const gaps = []; let g0 = -1;
      for (let i = 0; i <= n; i++) { const nan = i < n && x[i] !== x[i]; if (nan && g0 < 0) g0 = i; else if (!nan && g0 >= 0) { gaps.push([g0, i]); g0 = -1; } }
      const B = Math.max(1, Math.round(fs)), nb = Math.ceil(n / B), mn = new Float32Array(nb), mx = new Float32Array(nb);
      for (let k = 0; k < nb; k++) { let lo = Infinity, hi = -Infinity; for (let i = k * B, e = Math.min(n, i + B); i < e; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; } mn[k] = lo === Infinity ? NaN : lo; mx[k] = hi === -Infinity ? NaN : hi; }
      this._peak[chan] = Math.max(this._peak[chan] || 0, peak);
      return { chan, t0: h, fs, n, scale: peak, gaps, units: "counts", from: this.fdsn ? "FDSN dataselect" : "raw miniSEED", x, block: B, mn, mx };
    }
    async waveNorm(chan) { return { norm: Math.max(1, this._peak[chan] || 0), how: "the peak of the raw hours read so far" }; }
    async loadEvents() { this._ev = null; return null; }
    async loadEruptions() { this._m._eruptions = null; return null; }
    latent() { return Promise.resolve(null); }
  }

  // ------------------------------------------------------------------------------------------------ TreeRawSource (0.16)
  // a tiles-only tree with its raw miniSEED beside it: the tiles from the tree (on its own grid), a raw hour from the raw
  // folder unless the tree itself lists that hour. The manifest's wave index includes the raw hours
  class TreeRawSource extends StaticSource {
    constructor(tree, raw) {
      const m = { ...tree.manifest, wave: { ...(tree.manifest.wave || {}) } };
      for (const [c, v] of Object.entries(raw._m.wave || {})) m.wave[c] = { ...(m.wave[c] || {}), fs: v.fs, hours: [...new Set([...((m.wave[c] || {}).hours || []), ...v.hours])].sort() };
      super("", m, tree.io);
      this.raw = raw; this._treeWave = tree.manifest.wave || {};
    }
    _treeListed(chan, t) { const hrs = (this._treeWave[chan] || {}).hours; return !!hrs && hrs.includes(`${ymd(t)}/${hh(t)}`); }
    _chunkListed(chan, t, kind = "wave") { const h = Math.floor(t / HOUR) * HOUR; return kind === "wave" ? this._treeListed(chan, h) || this.raw._chunkListed(chan, h) : super._chunkListed(chan, t, kind); }
    hasWave(chan) { return !!(this._treeWave[chan] || {}).hours || this.raw.hasWave(chan); }
    _chunk(chan, t) { const h = Math.floor(t / HOUR) * HOUR; return this._treeListed(chan, h) ? super._chunk(chan, t) : this.raw._chunk(chan, t); }
    async waveNorm(chan) { return (this._m.ranges || {})[`wave:${chan}`] ? super.waveNorm(chan) : this.raw.waveNorm(chan); }
  }

  // ------------------------------------------------------------------------------------------------ FdsnSource (O1 step 3)
  // an FDSN web service (the researcher's own, or a public one that allows this page: CORS): the station service gives the
  // channels, their epochs and measured positions (StationXML, read with the page's own parser); dataselect gives an hour
  // of miniSEED when the view asks for it, decoded by the same worker. No data for an hour (204 / 404) is no data
  class FdsnSource extends RawSource {
    constructor(manifest, chans, fd) { super(manifest, chans); this.fdsn = fd; }
    async _dayFiles(source, fl, from, to) {
      const files = {}, iso = (x) => new Date(x * 1000).toISOString().slice(0, 19), [net, sta, loc] = source.split(".");
      await Promise.all(Object.entries(fl).map(async ([cha, ms]) => {
        if (!ms.some((m) => m.spanS[1] > from && m.spanS[0] < to)) return;
        const r = await fetch(`${this.fdsn.base}fdsnws/dataselect/1/query?net=${net}&sta=${sta}&loc=${loc || "--"}&cha=${cha}&starttime=${iso(from)}&endtime=${iso(to)}&nodata=404`, { cache: "no-store" });
        if (r.ok && r.status !== 204) { const b = await r.blob(); if (b.size) files[cha] = [b]; }
      }));
      return files;
    }
    _chunkListed(chan, t, kind = "wave") {
      if (kind !== "wave") return false;
      const c = this.chans.get(chan), h = Math.floor(t / HOUR) * HOUR;
      return !!c && c.some((m) => m.spanS[1] > h && m.spanS[0] < h + HOUR);
    }
    _chunk(chan, t) {
      const h = Math.floor(t / HOUR) * HOUR, key = `${chan}/${ymd(h)}/${hh(h)}`;
      if (!this._wave.has(key)) {
        if (!this._chunkListed(chan, h)) { this._wave.set(key, Promise.resolve(null)); return this._wave.get(key); }
        const [net, sta, loc, cha] = chan.split("."), iso = (x) => new Date(x * 1000).toISOString().slice(0, 19);
        const q = `${this.fdsn.base}fdsnws/dataselect/1/query?net=${net}&sta=${sta}&loc=${loc || "--"}&cha=${cha}&starttime=${iso(h)}&endtime=${iso(h + HOUR)}&nodata=404`;
        this._wave.set(key, fetch(q, { cache: "no-store" }).then(async (r) => {
          if (r.status === 204 || r.status === 404) return null;
          if (!r.ok) throw new Error(`dataselect ${r.status}`);
          const blob = await r.blob(); if (!blob.size) return null;
          const { segs } = await wkRead([{ blob }], h, h + HOUR);
          return this._hour(chan, h, segs.filter((sg) => sg.nslc === chan || !sg.nslc), this.chans.get(chan)[0].fs);
        }).catch((e) => { console.info("[source] FDSN hour not read", key, e.message); return null; }));
      }
      return this._wave.get(key);
    }
  }
  // the station service: channels (with their epochs and rates) and positions, for one NET.STA (LOC and CHA optional:
  // "NET.STA", "NET.STA.LOC", "NET.STA.LOC.CHA"; CHA may hold wildcards). → a source-shaped description
  async function fdsnFrom(url, code, published) {
    let base = String(url || "").trim();
    if (!/^https?:\/\//i.test(base)) throw new Error("an FDSN service address starts with https://");
    if (location.protocol === "https:" && /^http:\/\//i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(base)) throw new Error("this page is https, so it cannot read an http:// service (mixed content)");
    base = base.replace(/fdsnws\/.*$/, ""); if (!base.endsWith("/")) base += "/";
    const parts = String(code || "").trim().split("."), [net, sta, loc = "*", cha = "HH?,LM?"] = parts;
    if (!net || !sta) throw new Error("give the station as NETWORK.STATION, e.g. RK.MELH (optionally .LOCATION.CHANNELS)");
    const M = published.manifest(), iso = (x) => new Date(x * 1000).toISOString().slice(0, 19);
    const q = `${base}fdsnws/station/1/query?net=${net}&sta=${sta}&loc=${loc}&cha=${cha}&level=channel&format=xml&starttime=${iso(M.t0)}&endtime=${iso(M.t_end)}&nodata=404`;
    let text;
    try { const r = await fetch(q, { cache: "no-store" }); if (r.status === 204 || r.status === 404) throw new Error(`the station service knows no ${code} in the record's years`); if (!r.ok) throw new Error(`the station service answered ${r.status}`); text = await r.text(); }
    catch (e) { if (isNet(e)) throw new Error(`could not reach ${base}fdsnws/station/1/: the service is unreachable, or it does not let this page read it (CORS). It needs the header Access-Control-Allow-Origin: ${location.origin} (or *)`); throw e; }
    if (!window.SvkStations) throw new Error("the StationXML reader is not loaded");
    const list = window.SvkStations.parseStationXML(text);                         // the page's own StationXML parser
    const chans = new Map(), stations = new Map(), host = base.replace(/^https?:\/\//, "").replace(/\/$/, "");
    for (const e of list) for (const c of e.chans) {
      const id = `${e.net}.${e.sta}.${c.loc}`, nslc = `${id}.${c.code}`, a = c.start ? Date.parse(c.start) / 1000 : M.t0, b = c.end ? Date.parse(c.end) / 1000 : M.t_end;
      if (!chans.has(nslc)) chans.set(nslc, []);
      chans.get(nslc).push({ spanS: [Math.max(a, M.t0), Math.min(b, M.t_end)], fs: c.fs || 100 });
      if (!stations.has(id)) stations.set(id, { id, kind: "seismic", channels: [], coverage: [], lat: isNum(c.lat) ? c.lat : e.lat, lon: isNum(c.lon) ? c.lon : e.lon, elev: isNum(c.elev) ? c.elev : e.elev,
                                               pos_status: "measured", pos_source: `FDSN station service (${host})`, pos_err_m: e.err_m, pending: false, label: `${e.sta}: FDSN (${host})` });
      const st = stations.get(id); if (!st.channels.includes(c.code)) st.channels.push(c.code); st.coverage.push([Math.max(a, M.t0), Math.min(b, M.t_end)]);
    }
    if (!chans.size) throw new Error(`the station service lists no channels for ${code}`);
    for (const st of stations.values()) st.coverage = unionSpans(st.coverage);
    const manifest = { contract: "0.16", kind: "fdsn", public: false, built: null, t0: M.t0, t_end: M.t_end, tiers: {}, tiles: {}, spec: {}, stations: [...stations.values()],
                       wave: Object.fromEntries([...chans].map(([c, l]) => [c, { fs: l[0].fs, hours: [] }])) };
    await filterTables();
    return { raw: true, fdsn: { base, host }, kind: "url", label: `FDSN ${host}`, name: `FDSN ${host} · ${code}`, manifest, chans, stationXml: text, layout: "FDSN", skipped: 0, public: false, plain: false, check: null, io: null, doc: null, rates: rateNotes(manifest, chans) };
  }

  // ------------------------------------------------------------------------------------------------ open()
  // root: explicit opts.root → ?data= → window.SVK_CONFIG.dataRoot → the bridge's list of roots that exist → data/
  async function pickRoot(opts) {
    if (opts.root) return opts.root;
    const q = new URLSearchParams(location.search).get("data");
    if (q) return q.endsWith("/") ? q : q + "/";
    if (window.SVK_CONFIG && window.SVK_CONFIG.dataRoot) return window.SVK_CONFIG.dataRoot;
    if (opts.roots && opts.roots.length) return opts.roots[0];
    return "data/";
  }
  async function open(opts = {}) {
    const root = await pickRoot(opts);
    const m = await getJSON(`${root}manifest.json`);
    const mode = opts.mode || "archive";
    const src = mode === "live" && opts.url ? new LiveSource(root, m, opts.url) : new StaticSource(root, m);
    if (new URLSearchParams(location.search).get("lean") === "1") src._leanFixture();
    await src.loadEvents().catch((e) => console.warn("[source] events not loaded", e));
    await src.loadEruptions().catch((e) => console.warn("[source] eruptions not loaded", e));
    return src;
  }

  return { open, StaticSource, LiveSource, MergedSource, RawSource, FdsnSource, rawFrom, fdsnFrom, treeFromFiles, treeFromHandle, treeFromUrl, openMerged, verifyTree, mergeManifests, checkManifest, handleStore,
           util: { ymd, hh, lowerBound, DAY, HOUR } };
})();
